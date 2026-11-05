package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	// schemaVersion 7 asks the host to omit request bodies from after-auth
	// interception, which the tap ignores. Hosts accept older plugin schemas.
	schemaVersion uint32 = 7
	// maxQueuedBytes bounds the tap's memory inside the proxy.
	maxQueuedBytes = 64 << 20
	writeTimeout   = 5 * time.Second
	dialTimeout    = time.Second
)

// forwarded are the hooks the collector needs. Everything else gets an empty
// reply without being copied.
var forwarded = map[string]bool{
	"request.intercept_before":        true,
	"response.intercept_after":        true,
	"response.intercept_stream_chunk": true,
	"request.complete":                true,
	"usage.handle":                    true,
}

const registration = `{
  "schema_version": %d,
  "metadata": {
    "Name": "claudex-tap",
    "Version": "1.0.0",
    "Author": "claudex",
    "GitHubRepository": "https://github.com/Kanaliseren/claudex",
    "ConfigFields": [
      {"Name": "socket", "Type": "string", "Default": "", "Description": "Unix socket of the claudex request-log collector."}
    ]
  },
  "capabilities": {
    "request_interceptor": true,
    "request_interceptor_omit_body_after": true,
    "request_lifecycle_plugin": true,
    "response_interceptor": true,
    "response_stream_interceptor": true,
    "usage_plugin": true
  }
}`

var emptyResult = []byte(`{"ok":true,"result":{}}`)

type event struct {
	method  string
	payload []byte
}

type tap struct {
	mu      sync.Mutex
	socket  string
	queue   []event
	queued  int
	dropped uint64
	started bool

	wake chan struct{}
	stop chan struct{}
	done chan struct{}
}

var current = newTap()

func newTap() *tap {
	return &tap{wake: make(chan struct{}, 1)}
}

// call never fails and never blocks on I/O: a plugin error would only add
// host log noise, and the reply must leave the request unchanged.
func (t *tap) call(method string, payload []byte) []byte {
	defer func() { _ = recover() }()
	switch {
	case method == "plugin.register" || method == "plugin.reconfigure":
		return t.configure(payload)
	case forwarded[method]:
		t.enqueue(event{method, payload})
	}
	return emptyResult
}

var socketLine = regexp.MustCompile(`(?m)^\s*socket:\s*(.+?)\s*$`)

// configure reads the socket path from the plugin's YAML config (a single
// scalar, so no YAML library) and starts the writer once.
func (t *tap) configure(payload []byte) []byte {
	var req struct {
		ConfigYAML    []byte `json:"config_yaml"`
		SchemaVersion uint32 `json:"schema_version"`
	}
	_ = json.Unmarshal(payload, &req)
	socket := ""
	if m := socketLine.FindSubmatch(req.ConfigYAML); m != nil {
		socket = string(m[1])
		if unquoted, err := strconv.Unquote(socket); err == nil {
			socket = unquoted
		}
	}
	version := schemaVersion
	if req.SchemaVersion != 0 && req.SchemaVersion < version {
		version = req.SchemaVersion
	}

	t.mu.Lock()
	t.socket = socket
	if !t.started {
		t.started = true
		t.stop = make(chan struct{})
		t.done = make(chan struct{})
		go t.run()
	}
	t.mu.Unlock()
	// The collector logs this, and the claudex update canary waits for it.
	t.enqueue(event{"tap.hello", []byte(fmt.Sprintf(`{"schema_version":%d}`, version))})

	result := fmt.Sprintf(registration, version)
	return []byte(`{"ok":true,"result":` + result + `}`)
}

func (t *tap) enqueue(ev event) {
	t.mu.Lock()
	if t.queued+len(ev.payload) > maxQueuedBytes {
		t.dropped++
		t.mu.Unlock()
		return
	}
	t.queue = append(t.queue, ev)
	t.queued += len(ev.payload)
	t.mu.Unlock()
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

// run is the only goroutine that does I/O.
func (t *tap) run() {
	defer close(t.done)
	var conn net.Conn
	defer func() {
		if conn != nil {
			_ = conn.Close()
		}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lastReport := time.Now()
	for {
		select {
		case <-t.stop:
			return
		case <-t.wake:
		case <-ticker.C:
		}
		conn = t.flush(conn)
		if time.Since(lastReport) >= time.Minute {
			lastReport = time.Now()
			t.reportDrops()
		}
	}
}

// flush writes every queued event in order. On any error the connection is
// dropped with the rest of the batch; the next tick reconnects.
func (t *tap) flush(conn net.Conn) (out net.Conn) {
	out = conn
	defer func() {
		if recover() != nil && out != nil {
			_ = out.Close()
			out = nil
		}
	}()
	t.mu.Lock()
	batch, socket := t.queue, t.socket
	t.queue, t.queued = nil, 0
	t.mu.Unlock()
	if len(batch) == 0 {
		return out
	}
	if out == nil && socket != "" {
		if c, err := net.DialTimeout("unix", socket, dialTimeout); err == nil {
			out = c
		}
	}
	for i, ev := range batch {
		if out == nil || writeFrame(out, ev) != nil {
			if out != nil {
				_ = out.Close()
				out = nil
			}
			t.mu.Lock()
			t.dropped += uint64(len(batch) - i)
			t.mu.Unlock()
			return out
		}
	}
	return out
}

// writeFrame sends <uint32 length><uint8 method length><method><payload>.
func writeFrame(conn net.Conn, ev event) error {
	header := make([]byte, 5)
	binary.BigEndian.PutUint32(header, uint32(1+len(ev.method)+len(ev.payload)))
	header[4] = byte(len(ev.method))
	_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	bufs := net.Buffers{header, []byte(ev.method), ev.payload}
	_, err := bufs.WriteTo(conn)
	return err
}

func (t *tap) reportDrops() {
	t.mu.Lock()
	dropped := t.dropped
	t.dropped = 0
	t.mu.Unlock()
	if dropped > 0 {
		fmt.Fprintf(os.Stderr, "[claudex-tap] dropped %d events (collector unavailable or slow)\n", dropped)
	}
}

// shutdown stops the writer; the host may keep the library mapped, so no
// goroutine may outlive it.
func (t *tap) shutdown() {
	t.mu.Lock()
	started, stop, done := t.started, t.stop, t.done
	t.started = false
	t.mu.Unlock()
	if !started {
		return
	}
	close(stop)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
}
