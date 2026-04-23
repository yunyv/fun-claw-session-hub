package hubclient

import (
	"sync"
	"testing"
	"time"

	"github.com/funclaw/go-worker/internal/protocol"
)

func TestTaskSerialKey(t *testing.T) {
	tests := []struct {
		name string
		task *protocol.TaskAssignedPayload
		want string
	}{
		{
			name: "prefers openclaw session key",
			task: &protocol.TaskAssignedPayload{
				RequestID:          "req-1",
				SessionID:          "session-1",
				OpenclawSessionKey: "openclaw-1",
			},
			want: "openclaw-1",
		},
		{
			name: "falls back to session id",
			task: &protocol.TaskAssignedPayload{
				RequestID: "req-1",
				SessionID: "session-1",
			},
			want: "session-1",
		},
		{
			name: "falls back to request id",
			task: &protocol.TaskAssignedPayload{
				RequestID: "req-1",
			},
			want: "req-1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := taskSerialKey(tt.task)
			if got != tt.want {
				t.Fatalf("taskSerialKey() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestHubClientSerializesTasksWithSameSessionKey(t *testing.T) {
	releaseFirst := make(chan struct{})
	secondStarted := make(chan struct{})
	done := make(chan struct{})
	var mu sync.Mutex
	order := make([]string, 0, 4)

	client := New(HubClientOptions{
		OnTaskAssigned: func(task *protocol.TaskAssignedPayload) error {
			mu.Lock()
			order = append(order, "start:"+task.RequestID)
			mu.Unlock()

			if task.RequestID == "req-1" {
				<-releaseFirst
			} else {
				close(secondStarted)
			}

			mu.Lock()
			order = append(order, "done:"+task.RequestID)
			if len(order) == 4 {
				close(done)
			}
			mu.Unlock()
			return nil
		},
	})

	client.enqueueTaskAssigned(protocol.TaskAssignedPayload{
		RequestID:          "req-1",
		OpenclawSessionKey: "session-key-1",
	})
	client.enqueueTaskAssigned(protocol.TaskAssignedPayload{
		RequestID:          "req-2",
		OpenclawSessionKey: "session-key-1",
	})

	select {
	case <-secondStarted:
		t.Fatal("second task started before the first task completed")
	case <-time.After(80 * time.Millisecond):
	}

	close(releaseFirst)

	select {
	case <-secondStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for second task to start")
	}

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for queued tasks to finish")
	}

	mu.Lock()
	got := append([]string(nil), order...)
	mu.Unlock()
	want := []string{"start:req-1", "done:req-1", "start:req-2", "done:req-2"}
	if len(got) != len(want) {
		t.Fatalf("unexpected order length: got %v", got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("unexpected execution order: got %v, want %v", got, want)
		}
	}
}

func TestHubClientAllowsDifferentSessionKeysInParallel(t *testing.T) {
	started := make(chan string, 2)
	release := make(chan struct{})

	client := New(HubClientOptions{
		OnTaskAssigned: func(task *protocol.TaskAssignedPayload) error {
			started <- task.RequestID
			<-release
			return nil
		},
	})

	client.enqueueTaskAssigned(protocol.TaskAssignedPayload{
		RequestID:          "req-1",
		OpenclawSessionKey: "session-key-1",
	})
	client.enqueueTaskAssigned(protocol.TaskAssignedPayload{
		RequestID:          "req-2",
		OpenclawSessionKey: "session-key-2",
	})

	for i := 0; i < 2; i += 1 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for parallel task execution")
		}
	}

	close(release)
}
