package gatewayclient

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const testInlinePNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARAAA//8DAF0BBq1W3CYAAAAASUVORK5CYII="

func TestBuildAgentResultFromHistory_CollectsInlineArtifacts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"items": []interface{}{
				map[string]interface{}{
					"role":       "assistant",
					"content":    []interface{}{map[string]interface{}{"type": "text", "text": "old reply"}},
					"__openclaw": map[string]interface{}{"seq": 2},
				},
				map[string]interface{}{
					"role": "assistant",
					"content": []interface{}{
						map[string]interface{}{"type": "text", "text": "这是最新回复"},
						map[string]interface{}{
							"type":     "image",
							"filename": "inline.png",
							"mimeType": "image/png",
							"base64":   testInlinePNGBase64,
						},
					},
					"usage":      map[string]interface{}{"output_tokens": 9},
					"__openclaw": map[string]interface{}{"seq": 4},
				},
			},
		})
	}))
	defer server.Close()

	gw := New(server.URL, "token", server.URL+"/ws")
	result, artifacts, err := gw.buildAgentResultFromHistory(context.Background(), "session-1", 2)
	if err != nil {
		t.Fatalf("expected history extraction to succeed, got %v", err)
	}

	resultMap, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected result map, got %T", result)
	}
	if got := resultMap["payloads"].([]interface{})[0].(map[string]interface{})["text"]; got != "这是最新回复" {
		t.Fatalf("unexpected text payload: %#v", got)
	}
	if len(artifacts) != 1 {
		t.Fatalf("expected 1 artifact, got %#v", artifacts)
	}
	if artifacts[0].Filename != "inline.png" {
		t.Fatalf("unexpected filename: %#v", artifacts[0])
	}
	if artifacts[0].MimeType != "image/png" {
		t.Fatalf("unexpected mime type: %#v", artifacts[0])
	}
}

func TestBuildAgentResultFromHistory_DownloadsStructuredURLArtifacts(t *testing.T) {
	reportBody := []byte("report-bytes")
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sessions/session-1/history":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"items": []interface{}{
					map[string]interface{}{
						"role":       "assistant",
						"content":    []interface{}{map[string]interface{}{"type": "text", "text": "old reply"}},
						"__openclaw": map[string]interface{}{"seq": 2},
					},
					map[string]interface{}{
						"role": "assistant",
						"content": []interface{}{
							map[string]interface{}{"type": "text", "text": "报告已经生成"},
							map[string]interface{}{
								"type":         "file",
								"download_url": server.URL + "/downloads/report",
							},
						},
						"__openclaw": map[string]interface{}{"seq": 4},
					},
				},
			})
		case "/downloads/report":
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Disposition", `attachment; filename="report.bin"`)
			w.Write(reportBody)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	gw := New(server.URL, "token", server.URL+"/ws")
	_, artifacts, err := gw.buildAgentResultFromHistory(context.Background(), "session-1", 2)
	if err != nil {
		t.Fatalf("expected history extraction to succeed, got %v", err)
	}
	if len(artifacts) != 1 {
		t.Fatalf("expected 1 artifact, got %#v", artifacts)
	}
	if artifacts[0].Filename != "report.bin" {
		t.Fatalf("unexpected filename: %#v", artifacts[0])
	}
	if artifacts[0].MimeType != "application/octet-stream" {
		t.Fatalf("unexpected mime type: %#v", artifacts[0])
	}
	decoded, err := base64.StdEncoding.DecodeString(artifacts[0].ContentBase64)
	if err != nil {
		t.Fatalf("expected valid artifact base64, got %v", err)
	}
	if string(decoded) != string(reportBody) {
		t.Fatalf("unexpected downloaded artifact content: %q", string(decoded))
	}
}

func TestBuildAgentResultFromHistory_FailsWhenArtifactDownloadFails(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sessions/session-1/history":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"items": []interface{}{
					map[string]interface{}{
						"role": "assistant",
						"content": []interface{}{
							map[string]interface{}{"type": "text", "text": "下载地址如下"},
							map[string]interface{}{
								"type":         "file",
								"download_url": server.URL + "/downloads/missing",
							},
						},
						"__openclaw": map[string]interface{}{"seq": 4},
					},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	gw := New(server.URL, "token", server.URL+"/ws")
	_, _, err := gw.buildAgentResultFromHistory(context.Background(), "session-1", 0)
	if err == nil {
		t.Fatal("expected artifact download failure")
	}
}
