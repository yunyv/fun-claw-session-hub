package gatewayclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	ws "github.com/gorilla/websocket"
)

func TestGetSessionHistory_SendsOperatorReadScope(t *testing.T) {
	var seenAuth, seenScopes string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		seenScopes = r.Header.Get("X-OpenClaw-Scopes")
		// path seen but not used
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"history": []interface{}{}})
	}))
	defer server.Close()

	gw := New(server.URL, "gateway-secret", server.URL+"/ws")

	result, err := gw.GetSessionHistory(
		context.Background(),
		"session-1",
		map[string]interface{}{"limit": 20, "cursor": "abc"},
	)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	resultMap, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	if _, ok := resultMap["history"]; !ok {
		t.Errorf("expected history field in result")
	}
	if seenAuth != "Bearer gateway-secret" {
		t.Errorf("expected auth=Bearer gateway-secret, got %s", seenAuth)
	}
	if seenScopes != "operator.read" {
		t.Errorf("expected scopes=operator.read, got %s", seenScopes)
	}
}

func TestNormalizeNodeArtifacts(t *testing.T) {
	gw := New("http://localhost:18789", "", "ws://localhost:18789")

	tests := []struct {
		name    string
		input   interface{}
		wantArt int
	}{
		{"nil input", nil, 0},
		{"non-map input", "string", 0},
		{"no base64", map[string]interface{}{"result": "some text"}, 0},
		{"with base64 image", map[string]interface{}{
			"base64":   "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"format":   "png",
			"mimeType": "image/png",
		}, 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, arts := gw.NormalizeNodeArtifacts(tt.input)
			if len(arts) != tt.wantArt {
				t.Errorf("expected %d artifacts, got %d", tt.wantArt, len(arts))
			}
		})
	}
}

func TestDetectArtifactKind(t *testing.T) {
	tests := []struct {
		mimeType string
		expected string
	}{
		{"image/png", "image"},
		{"image/jpeg", "image"},
		{"video/mp4", "video"},
		{"audio/mp3", "audio"},
		{"application/pdf", "file"},
		{"", "file"},
	}
	for _, tt := range tests {
		got := detectArtifactKind(tt.mimeType)
		if got != tt.expected {
			t.Errorf("detectArtifactKind(%q) = %q, want %q", tt.mimeType, got, tt.expected)
		}
	}
}

func TestMimeTypeFromFormat(t *testing.T) {
	tests := []struct {
		format   string
		expected string
	}{
		{"jpg", "image/jpeg"},
		{"jpeg", "image/jpeg"},
		{"png", "image/png"},
		{"mp4", "video/mp4"},
		{"unknown", "application/octet-stream"},
	}
	for _, tt := range tests {
		got := mimeTypeFromFormat(tt.format)
		if got != tt.expected {
			t.Errorf("mimeTypeFromFormat(%q) = %q, want %q", tt.format, got, tt.expected)
		}
	}
}

func TestEncodeURIComponent(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"session-1", "session-1"},
		{"foo:bar", "foo%3Abar"},
		{"a b", "a%20b"},
		{"hello", "hello"},
	}
	for _, tt := range tests {
		got := encodeURIComponent(tt.input)
		if got != tt.expected {
			t.Errorf("encodeURIComponent(%q) = %q, want %q", tt.input, got, tt.expected)
		}
	}
}

func TestGetSessionHistory_ErrorHandling(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"error": "not found"}`)
	}))
	defer server.Close()

	gw := New(server.URL, "token", server.URL)

	_, err := gw.GetSessionHistory(context.Background(), "session-1", nil)

	if err == nil {
		t.Error("expected error for non-200 response")
	}
}

func TestTransformToAgentParams_TextImageAndFile(t *testing.T) {
	params := transformToAgentParams(
		map[string]interface{}{
			"model": "openclaw",
			"input": []interface{}{
				map[string]interface{}{
					"type": "message",
					"role": "user",
					"content": []interface{}{
						map[string]interface{}{"type": "input_text", "text": "图里是什么颜色？"},
						map[string]interface{}{
							"type": "input_image",
							"source": map[string]interface{}{
								"type":       "base64",
								"media_type": "image/png",
								"filename":   "color.png",
								"data":       "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARAAA//8DAF0BBq1W3CYAAAAASUVORK5CYII=",
							},
						},
						map[string]interface{}{
							"type": "input_file",
							"source": map[string]interface{}{
								"type":       "base64",
								"media_type": "text/plain",
								"filename":   "hello.txt",
								"data":       "aGVsbG8=",
							},
						},
					},
				},
			},
		},
		"agent:main:test",
	)

	if got, _ := params["sessionKey"].(string); got != "agent:main:test" {
		t.Fatalf("expected sessionKey to be forwarded, got %q", got)
	}
	if got, _ := params["message"].(string); got != "图里是什么颜色？\n\n[文件 hello.txt]\nhello" {
		t.Fatalf("unexpected message: %q", got)
	}
	extraSystemPrompt, _ := params["extraSystemPrompt"].(string)
	if !strings.Contains(extraSystemPrompt, "A local filesystem path alone does not count as completed delivery.") {
		t.Fatalf("expected FunClaw OSS delivery prompt, got %q", extraSystemPrompt)
	}
	if !strings.Contains(extraSystemPrompt, "This applies to every file type and to both intermediate files and final files.") {
		t.Fatalf("expected prompt to require OSS upload for all file types and file states, got %q", extraSystemPrompt)
	}
	attachments, ok := params["attachments"].([]interface{})
	if !ok || len(attachments) != 1 {
		t.Fatalf("expected one image attachment, got %#v", params["attachments"])
	}
	attachment, ok := attachments[0].(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected attachment type: %T", attachments[0])
	}
	expected := map[string]interface{}{
		"type":     "image",
		"mimeType": "image/png",
		"fileName": "color.png",
	}
	for key, want := range expected {
		if !reflect.DeepEqual(attachment[key], want) {
			t.Fatalf("attachment[%s] = %#v, want %#v", key, attachment[key], want)
		}
	}
	if content, _ := attachment["content"].(string); content == "" {
		t.Fatal("expected image attachment content to be preserved")
	}
}

func TestTransformToAgentParams_AppendsExistingExtraSystemPrompt(t *testing.T) {
	params := transformToAgentParams(
		map[string]interface{}{
			"extraSystemPrompt": "Caller-specific rule.",
			"input":             "生成一个文件",
		},
		"agent:main:test",
	)

	extraSystemPrompt, _ := params["extraSystemPrompt"].(string)
	if !strings.Contains(extraSystemPrompt, "Caller-specific rule.") {
		t.Fatalf("expected caller extraSystemPrompt to be preserved, got %q", extraSystemPrompt)
	}
	if !strings.Contains(extraSystemPrompt, "upload every such file to OSS before the final reply") {
		t.Fatalf("expected FunClaw OSS delivery rule to be appended, got %q", extraSystemPrompt)
	}
	if !strings.Contains(extraSystemPrompt, "both intermediate files and final files") {
		t.Fatalf("expected appended rule to cover intermediate and final files, got %q", extraSystemPrompt)
	}
}

func TestNormalizeNodeArtifacts_UsesNestedPayload(t *testing.T) {
	gw := New("http://localhost:18789", "", "ws://localhost:18789")

	result, artifacts := gw.NormalizeNodeArtifacts(map[string]interface{}{
		"ok": true,
		"payload": map[string]interface{}{
			"base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARAAA//8DAF0BBq1W3CYAAAAASUVORK5CYII=",
			"format": "png",
		},
	})

	if len(artifacts) != 1 {
		t.Fatalf("expected one artifact, got %d", len(artifacts))
	}
	resultMap, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	payload, ok := resultMap["payload"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected nested payload map, got %#v", resultMap["payload"])
	}
	if _, stillHasBase64 := payload["base64"]; stillHasBase64 {
		t.Fatal("expected base64 to be stripped from nested payload")
	}
}

func TestWaitForAgentCompletion_ContinuesAfterTimeout(t *testing.T) {
	var waitCalls atomic.Int32
	upgrader := ws.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("failed to upgrade websocket: %v", err)
			return
		}
		defer conn.Close()

		statuses := []string{"timeout", "ok"}
		for _, status := range statuses {
			_, rawMessage, err := conn.ReadMessage()
			if err != nil {
				t.Errorf("failed to read websocket message: %v", err)
				return
			}

			var frame map[string]interface{}
			if err := json.Unmarshal(rawMessage, &frame); err != nil {
				t.Errorf("failed to decode websocket frame: %v", err)
				return
			}
			if gotMethod, _ := frame["method"].(string); gotMethod != "agent.wait" {
				t.Errorf("expected agent.wait method, got %q", gotMethod)
				return
			}

			params, ok := frame["params"].(map[string]interface{})
			if !ok {
				t.Errorf("expected params map, got %#v", frame["params"])
				return
			}
			if gotRunID, _ := params["runId"].(string); gotRunID != "run-1" {
				t.Errorf("expected runId run-1, got %q", gotRunID)
				return
			}
			if gotTimeoutMs, ok := params["timeoutMs"].(float64); !ok || int(gotTimeoutMs) != agentWaitTimeoutMs {
				t.Errorf("expected timeoutMs=%d, got %#v", agentWaitTimeoutMs, params["timeoutMs"])
				return
			}

			waitCalls.Add(1)

			if status == "timeout" {
				if err := conn.WriteJSON(map[string]interface{}{
					"type":  "event",
					"event": "tick",
				}); err != nil {
					t.Errorf("failed to write tick event: %v", err)
					return
				}
			}

			if err := conn.WriteJSON(map[string]interface{}{
				"type": "res",
				"id":   frame["id"],
				"ok":   true,
				"payload": map[string]interface{}{
					"runId":  "run-1",
					"status": status,
				},
			}); err != nil {
				t.Errorf("failed to write agent.wait response: %v", err)
				return
			}
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := ws.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("failed to dial websocket test server: %v", err)
	}
	defer conn.Close()

	gw := New(server.URL, "", wsURL)
	payload, err := gw.waitForAgentCompletion(conn, "run-1")
	if err != nil {
		t.Fatalf("expected waitForAgentCompletion to succeed, got %v", err)
	}

	if gotStatus, _ := payload["status"].(string); gotStatus != "ok" {
		t.Fatalf("expected final status ok, got %#v", payload["status"])
	}
	if waitCalls.Load() != 2 {
		t.Fatalf("expected 2 agent.wait calls, got %d", waitCalls.Load())
	}
}

func TestBuildAgentResultFromHistory_SkipsBaselineAndEmptyAssistantEntries(t *testing.T) {
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
						map[string]interface{}{
							"type":      "toolCall",
							"id":        "call-1",
							"name":      "read",
							"arguments": map[string]interface{}{"path": "/tmp/demo.txt", "limit": 1},
						},
					},
					"__openclaw": map[string]interface{}{"seq": 4},
				},
				map[string]interface{}{
					"role":       "toolResult",
					"toolCallId": "call-1",
					"toolName":   "read",
					"content": []interface{}{
						map[string]interface{}{"type": "text", "text": "---\n\n[233 more lines in file.]"},
					},
					"isError":    false,
					"__openclaw": map[string]interface{}{"seq": 5},
				},
				map[string]interface{}{
					"role":       "assistant",
					"content":    []interface{}{map[string]interface{}{"type": "text", "text": "fresh reply"}},
					"usage":      map[string]interface{}{"output_tokens": 11},
					"__openclaw": map[string]interface{}{"seq": 6},
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
	if len(artifacts) != 0 {
		t.Fatalf("expected no artifacts, got %#v", artifacts)
	}

	expect := map[string]interface{}{
		"payloads": []interface{}{map[string]interface{}{"text": "fresh reply"}},
		"meta":     map[string]interface{}{"usage": map[string]interface{}{"output_tokens": 11.0}},
		"tool_calls": []interface{}{
			map[string]interface{}{
				"seq":       4,
				"id":        "call-1",
				"name":      "read",
				"arguments": map[string]interface{}{"path": "/tmp/demo.txt", "limit": 1.0},
			},
		},
		"tool_results_summary": []interface{}{
			map[string]interface{}{
				"seq":          5,
				"tool_call_id": "call-1",
				"name":         "read",
				"summary":      "--- [233 more lines in file.]",
				"is_error":     false,
			},
		},
	}
	if !reflect.DeepEqual(result, expect) {
		t.Fatalf("unexpected history-derived result: %#v", result)
	}
}

func TestBuildAgentResultFromHistory_ErrorsWhenAssistantTextIsMissing(t *testing.T) {
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
					"role":       "assistant",
					"content":    []interface{}{map[string]interface{}{"type": "tool_call", "name": "read"}},
					"__openclaw": map[string]interface{}{"seq": 4},
				},
			},
		})
	}))
	defer server.Close()

	gw := New(server.URL, "token", server.URL+"/ws")
	_, _, err := gw.buildAgentResultFromHistory(context.Background(), "session-1", 2)
	if err == nil {
		t.Fatal("expected history extraction to fail when assistant text is missing")
	}
	if !strings.Contains(err.Error(), "no assistant text entry found after seq=2") {
		t.Fatalf("unexpected error: %v", err)
	}
}
