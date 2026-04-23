package gatewayclient

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/funclaw/go-worker/internal/protocol"
)

var artifactURLFieldNames = []string{
	"url",
	"download_url",
	"downloadUrl",
	"file_url",
	"fileUrl",
	"image_url",
	"imageUrl",
	"oss_url",
	"ossUrl",
}

type agentArtifactCollector struct {
	client        *GatewayClient
	ctx           context.Context
	contentHashes map[string]struct{}
	urls          map[string]struct{}
	artifacts     []protocol.NormalizedArtifact
}

func newAgentArtifactCollector(client *GatewayClient, ctx context.Context) *agentArtifactCollector {
	return &agentArtifactCollector{
		client:        client,
		ctx:           ctx,
		contentHashes: make(map[string]struct{}),
		urls:          make(map[string]struct{}),
		artifacts:     make([]protocol.NormalizedArtifact, 0),
	}
}

// collectFromRecord scans the history record fields that may carry file results.
func (c *agentArtifactCollector) collectFromRecord(record map[string]interface{}, seq int) error {
	for _, fieldName := range []string{"content", "toolOutput", "output", "result"} {
		if err := c.collectFromValue(record[fieldName], seq, fieldName, isTextCarrierField(fieldName)); err != nil {
			return err
		}
	}
	return nil
}

func (c *agentArtifactCollector) collectFromValue(
	value interface{},
	seq int,
	fieldName string,
	allowTextURL bool,
) error {
	switch current := value.(type) {
	case nil:
		return nil
	case []interface{}:
		for _, item := range current {
			if err := c.collectFromValue(item, seq, fieldName, allowTextURL); err != nil {
				return err
			}
		}
		return nil
	case map[string]interface{}:
		if err := c.collectInlineArtifact(current, seq); err != nil {
			return err
		}
		if err := c.collectStructuredURLArtifacts(current, seq); err != nil {
			return err
		}
		for key, nested := range current {
			normalizedKey := normalizeArtifactFieldName(key)
			if isBinaryBlobKey(normalizedKey) || isArtifactURLField(normalizedKey) {
				continue
			}
			nextAllowText := allowTextURL || isTextCarrierField(key)
			if err := c.collectFromValue(nested, seq, key, nextAllowText); err != nil {
				return err
			}
		}
		return nil
	case string:
		if !allowTextURL {
			return nil
		}
		for _, rawURL := range extractStandaloneHTTPURLs(current) {
			if err := c.collectDownloadedURLArtifact(rawURL, nil, seq); err != nil {
				return err
			}
		}
		return nil
	default:
		return nil
	}
}

func (c *agentArtifactCollector) collectInlineArtifact(part map[string]interface{}, seq int) error {
	artifact, raw, ok, err := buildInlineArtifactFromMap(part, seq)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	hash := sha256.Sum256(raw)
	hashKey := hex.EncodeToString(hash[:])
	if _, exists := c.contentHashes[hashKey]; exists {
		return nil
	}
	c.contentHashes[hashKey] = struct{}{}
	c.artifacts = append(c.artifacts, artifact)
	return nil
}

func (c *agentArtifactCollector) collectStructuredURLArtifacts(part map[string]interface{}, seq int) error {
	for _, fieldName := range artifactURLFieldNames {
		rawURL := strings.TrimSpace(firstStringValue(part[fieldName]))
		if rawURL == "" {
			continue
		}
		if err := c.collectDownloadedURLArtifact(rawURL, part, seq); err != nil {
			return err
		}
	}
	return nil
}

func (c *agentArtifactCollector) collectDownloadedURLArtifact(
	rawURL string,
	hints map[string]interface{},
	seq int,
) error {
	normalizedURL, parsedURL, err := normalizeHTTPURL(rawURL)
	if err != nil {
		return fmt.Errorf("invalid artifact url at seq=%d: %w", seq, err)
	}
	if _, exists := c.urls[normalizedURL]; exists {
		return nil
	}
	artifact, err := c.client.downloadArtifactFromURL(c.ctx, normalizedURL, parsedURL, hints, seq)
	if err != nil {
		return err
	}
	c.urls[normalizedURL] = struct{}{}
	c.artifacts = append(c.artifacts, artifact)
	return nil
}

func buildInlineArtifactFromMap(
	part map[string]interface{},
	seq int,
) (protocol.NormalizedArtifact, []byte, bool, error) {
	if source, ok := part["source"].(map[string]interface{}); ok {
		sourceType := normalizeContentBlockType(firstStringValue(source["type"]))
		if sourceType == "base64" {
			return buildInlineArtifactFromCandidate(source, part, seq)
		}
	}
	return buildInlineArtifactFromCandidate(part, nil, seq)
}

func buildInlineArtifactFromCandidate(
	candidate map[string]interface{},
	parent map[string]interface{},
	seq int,
) (protocol.NormalizedArtifact, []byte, bool, error) {
	dataKey, data := firstInlineDataValue(candidate)
	if data == "" {
		return protocol.NormalizedArtifact{}, nil, false, nil
	}
	if dataKey != "base64" && !hasArtifactMetadata(candidate, parent) {
		return protocol.NormalizedArtifact{}, nil, false, nil
	}

	raw, err := decodeBase64Bytes(data)
	if err != nil {
		return protocol.NormalizedArtifact{}, nil, false, fmt.Errorf(
			"invalid base64 artifact at seq=%d: %w",
			seq,
			err,
		)
	}

	mimeType := firstStringValue(
		candidate["mimeType"],
		candidate["mime_type"],
		candidate["media_type"],
	)
	format := firstStringValue(candidate["format"])
	filename := firstStringValue(candidate["filename"], candidate["fileName"], candidate["name"])
	if parent != nil {
		if mimeType == "" {
			mimeType = firstStringValue(parent["mimeType"], parent["mime_type"], parent["media_type"])
		}
		if format == "" {
			format = firstStringValue(parent["format"])
		}
		if filename == "" {
			filename = firstStringValue(parent["filename"], parent["fileName"], parent["name"])
		}
	}

	if mimeType == "" && format != "" {
		mimeType = mimeTypeFromFormat(strings.ToLower(format))
	}
	if mimeType == "" && filename != "" {
		mimeType = mimeTypeFromFilename(filename)
	}
	if mimeType == "" {
		mimeType = http.DetectContentType(raw)
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	if filename == "" {
		filename = buildAgentArtifactFilename(seq, mimeType, format)
	}

	meta := map[string]interface{}{}
	if strings.TrimSpace(format) != "" {
		meta["format"] = format
	}

	return protocol.NormalizedArtifact{
		Kind:          detectArtifactKind(mimeType),
		Filename:      filename,
		MimeType:      mimeType,
		ContentBase64: base64.StdEncoding.EncodeToString(raw),
		Meta:          normalizeArtifactMeta(meta),
	}, raw, true, nil
}

func (c *GatewayClient) downloadArtifactFromURL(
	ctx context.Context,
	normalizedURL string,
	parsedURL *url.URL,
	hints map[string]interface{},
	seq int,
) (protocol.NormalizedArtifact, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, normalizedURL, nil)
	if err != nil {
		return protocol.NormalizedArtifact{}, fmt.Errorf("failed to create artifact download request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return protocol.NormalizedArtifact{}, fmt.Errorf("failed to download artifact %s: %w", normalizedURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return protocol.NormalizedArtifact{}, fmt.Errorf(
			"artifact download failed for %s: %d %s",
			normalizedURL,
			resp.StatusCode,
			strings.TrimSpace(string(bodyBytes)),
		)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return protocol.NormalizedArtifact{}, fmt.Errorf("failed to read artifact body from %s: %w", normalizedURL, err)
	}
	if len(raw) == 0 {
		return protocol.NormalizedArtifact{}, fmt.Errorf("artifact download returned empty body for %s", normalizedURL)
	}

	filename := ""
	mimeType := ""
	format := ""
	if hints != nil {
		filename = firstStringValue(hints["filename"], hints["fileName"], hints["name"])
		mimeType = firstStringValue(hints["mimeType"], hints["mime_type"], hints["media_type"])
		format = firstStringValue(hints["format"])
	}
	if filename == "" {
		filename = filenameFromContentDisposition(resp.Header.Get("Content-Disposition"))
	}
	if filename == "" {
		filename = filenameFromURL(parsedURL)
	}

	if mimeType == "" {
		mimeType = mimeTypeFromHeader(resp.Header.Get("Content-Type"))
	}
	if mimeType == "" && filename != "" {
		mimeType = mimeTypeFromFilename(filename)
	}
	if mimeType == "" && format != "" {
		mimeType = mimeTypeFromFormat(strings.ToLower(format))
	}
	if mimeType == "" {
		mimeType = http.DetectContentType(raw)
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	if filename == "" {
		filename = buildAgentArtifactFilename(seq, mimeType, format)
	}

	meta := map[string]interface{}{
		"source_url": normalizedURL,
	}
	if strings.TrimSpace(format) != "" {
		meta["format"] = format
	}

	return protocol.NormalizedArtifact{
		Kind:          detectArtifactKind(mimeType),
		Filename:      filename,
		MimeType:      mimeType,
		ContentBase64: base64.StdEncoding.EncodeToString(raw),
		Meta:          normalizeArtifactMeta(meta),
	}, nil
}

func normalizeHTTPURL(rawURL string) (string, *url.URL, error) {
	parsedURL, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", nil, err
	}
	scheme := strings.ToLower(strings.TrimSpace(parsedURL.Scheme))
	if scheme != "http" && scheme != "https" {
		return "", nil, fmt.Errorf("unsupported url scheme %q", parsedURL.Scheme)
	}
	if strings.TrimSpace(parsedURL.Host) == "" {
		return "", nil, fmt.Errorf("missing url host")
	}
	parsedURL.Fragment = ""
	return parsedURL.String(), parsedURL, nil
}

func decodeBase64Bytes(data string) ([]byte, error) {
	raw := stripDataURLPrefix(data)
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err == nil {
		return decoded, nil
	}
	decoded, rawErr := base64.RawStdEncoding.DecodeString(raw)
	if rawErr == nil {
		return decoded, nil
	}
	return nil, err
}

func firstInlineDataValue(part map[string]interface{}) (string, string) {
	for _, fieldName := range []string{"base64", "data", "content"} {
		if value := strings.TrimSpace(firstStringValue(part[fieldName])); value != "" {
			return fieldName, value
		}
	}
	return "", ""
}

func hasArtifactMetadata(candidate map[string]interface{}, parent map[string]interface{}) bool {
	values := []interface{}{
		candidate["mimeType"],
		candidate["mime_type"],
		candidate["media_type"],
		candidate["format"],
		candidate["filename"],
		candidate["fileName"],
		candidate["name"],
	}
	if parent != nil {
		values = append(values,
			parent["mimeType"],
			parent["mime_type"],
			parent["media_type"],
			parent["format"],
			parent["filename"],
			parent["fileName"],
			parent["name"],
		)
	}
	if firstStringValue(values...) != "" {
		return true
	}

	typeLabel := normalizeContentBlockType(firstStringValue(candidate["type"]))
	switch typeLabel {
	case "image", "imagefile", "file", "artifact", "attachment", "audio", "video", "document":
		return true
	default:
		return false
	}
}

func extractStandaloneHTTPURLs(text string) []string {
	urls := make([]string, 0)
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) != 1 {
			continue
		}
		candidate := strings.Trim(fields[0], "\"'()[]<>.,")
		if strings.HasPrefix(strings.ToLower(candidate), "http://") ||
			strings.HasPrefix(strings.ToLower(candidate), "https://") {
			urls = append(urls, candidate)
		}
	}
	return urls
}

func normalizeArtifactFieldName(fieldName string) string {
	replacer := strings.NewReplacer("_", "", "-", "")
	return replacer.Replace(strings.ToLower(strings.TrimSpace(fieldName)))
}

func isArtifactURLField(fieldName string) bool {
	switch normalizeArtifactFieldName(fieldName) {
	case "url", "downloadurl", "fileurl", "imageurl", "ossurl":
		return true
	default:
		return false
	}
}

func isBinaryBlobKey(fieldName string) bool {
	switch normalizeArtifactFieldName(fieldName) {
	case "base64", "data", "contentbase64", "inlinebase64":
		return true
	default:
		return false
	}
}

func isTextCarrierField(fieldName string) bool {
	switch normalizeArtifactFieldName(fieldName) {
	case "text", "content", "message", "output", "result", "tooloutput":
		return true
	default:
		return false
	}
}

func buildAgentArtifactFilename(seq int, mimeType string, format string) string {
	ext := "bin"
	if strings.TrimSpace(format) != "" {
		ext = extFromFormat(strings.ToLower(format))
	} else if mimeType != "" {
		if mimeExt := extFromMimeType(mimeType); mimeExt != "" {
			ext = mimeExt
		}
	}
	return fmt.Sprintf("agent-artifact-%d.%s", seq, strings.TrimPrefix(ext, "."))
}

func extFromMimeType(mimeType string) string {
	if mimeType == "" {
		return ""
	}
	extensions, err := mime.ExtensionsByType(mimeType)
	if err != nil || len(extensions) == 0 {
		return ""
	}
	return strings.TrimPrefix(extensions[0], ".")
}

func mimeTypeFromFilename(fileName string) string {
	ext := strings.ToLower(path.Ext(strings.TrimSpace(fileName)))
	if ext == "" {
		return ""
	}
	contentType := mime.TypeByExtension(ext)
	return mimeTypeFromHeader(contentType)
}

func mimeTypeFromHeader(headerValue string) string {
	trimmed := strings.TrimSpace(headerValue)
	if trimmed == "" {
		return ""
	}
	mediaType, _, err := mime.ParseMediaType(trimmed)
	if err != nil {
		return trimmed
	}
	return mediaType
}

func filenameFromContentDisposition(headerValue string) string {
	if strings.TrimSpace(headerValue) == "" {
		return ""
	}
	_, params, err := mime.ParseMediaType(headerValue)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(params["filename"])
}

func filenameFromURL(parsedURL *url.URL) string {
	if parsedURL == nil {
		return ""
	}
	baseName := path.Base(parsedURL.Path)
	if baseName == "." || baseName == "/" || strings.TrimSpace(baseName) == "" {
		return ""
	}
	return baseName
}

func normalizeArtifactMeta(meta map[string]interface{}) map[string]interface{} {
	if len(meta) == 0 {
		return nil
	}
	return meta
}
