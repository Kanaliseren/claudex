package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	// schemaVersion 7 asks the host to omit request bodies from after-auth
	// interception, which the tap ignores. Hosts accept older plugin schemas.
	schemaVersion uint32 = 7
	// maxPendingBytes bounds the tap's memory inside the proxy: payloads are
	// counted from before they are copied until they are written or dropped.
	maxPendingBytes = 64 << 20
	// shutdown closes the connection, which interrupts a write in progress.
	writeTimeout = 5 * time.Second
	shutdownWait = 3 * time.Second
	dialTimeout  = time.Second
)

// forwarded are the hooks the collector needs. Everything else gets an empty
// reply without its payload ever being copied.
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
	// lostBefore counts events dropped since the previous queued event; the
	// collector is told just before this one, while their request is open.
	lostBefore uint64
}

type tap struct {
	mu      sync.Mutex
	socket  string
	queue   []event
	pending int    // reserved bytes: copying, queued or being written
	lost    uint64 // drops not yet attached to a queued event
	closed  bool
	running bool
	conn    net.Conn

	wake chan struct{}
	stop chan struct{}
	done chan struct{}
}

var current = newTap()

func newTap() *tap {
	return &tap{wake: make(chan struct{}, 1)}
}

// wants reports whether a method's payload is needed, so the C glue copies
// nothing for every other hook.
func (t *tap) wants(method string) bool {
	return forwarded[method] || method == "plugin.register" || method == "plugin.reconfigure"
}

// reserve claims n bytes before the payload is copied. It fails, and the
// event is dropped, when the tap is shut down or the bound would be exceeded.
func (t *tap) reserve(n int) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed || t.pending+n > maxPendingBytes {
		t.lost++
		return false
	}
	t.pending += n
	return true
}

// call never fails and never blocks on I/O: a plugin error would only add
// host log noise, and the reply must leave the request unchanged. Forwarded
// payloads arrive already reserved.
func (t *tap) call(method string, payload []byte) []byte {
	defer func() { _ = recover() }()
	switch {
	case method == "plugin.register" || method == "plugin.reconfigure":
		return t.configure(payload)
	case forwarded[method]:
		t.push(event{method: method, payload: payload})
	}
	return emptyResult
}

func (t *tap) push(ev event) {
	t.mu.Lock()
	if t.closed {
		t.pending -= len(ev.payload)
		t.lost++
		t.mu.Unlock()
		return
	}
	ev.lostBefore, t.lost = t.lost, 0
	t.queue = append(t.queue, ev)
	t.mu.Unlock()
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

var socketLine = regexp.MustCompile(`(?m)^\s*socket:\s*(.+?)\s*$`)

// configure reads the socket path from the plugin's YAML config (a single
// scalar, so no YAML library) and starts the writer if it is not running.
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
	t.closed = false
	if t.running {
		// A writer told to stop (shutdown, then a reload of the still-mapped
		// library) must exit before a new one starts.
		select {
		case <-t.stop:
			done := t.done
			t.mu.Unlock()
			<-done
			t.mu.Lock()
		default:
		}
	}
	if !t.running {
		t.running = true
		t.stop = make(chan struct{})
		t.done = make(chan struct{})
		go t.run(t.stop, t.done)
	}
	t.mu.Unlock()
	// Lets the collector log which proxy schema it is serving.
	hello := []byte(fmt.Sprintf(`{"schema_version":%d}`, version))
	if t.reserve(len(hello)) {
		t.push(event{method: "tap.hello", payload: hello})
	}

	result := fmt.Sprintf(registration, version)
	return []byte(`{"ok":true,"result":` + result + `}`)
}

// run is the only goroutine that does I/O.
func (t *tap) run(stop, done chan struct{}) {
	defer func() {
		t.mu.Lock()
		t.running = false
		if t.conn != nil {
			_ = t.conn.Close()
			t.conn = nil
		}
		t.mu.Unlock()
		close(done)
	}()
	// No stderr output: a blocked log pipe must never wedge the writer. Drops
	// are reported by the collector instead.
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.wake:
		case <-ticker.C:
		}
		t.flush()
	}
}

// flush writes every queued event in order, each preceded by an announcement
// of the drops just before it. On any error the connection and the rest of
// the batch are dropped (and counted); the next tick reconnects.
func (t *tap) flush() {
	t.mu.Lock()
	batch, socket, conn := t.queue, t.socket, t.conn
	t.queue = nil
	t.mu.Unlock()
	written := 0
	defer func() {
		_ = recover()
		t.mu.Lock()
		for i, ev := range batch {
			t.pending -= len(ev.payload)
			if i >= written {
				t.lost += ev.lostBefore + 1
			}
		}
		t.mu.Unlock()
	}()
	if len(batch) == 0 {
		return
	}
	if conn == nil && socket != "" {
		if c, err := net.DialTimeout("unix", socket, dialTimeout); err == nil {
			conn = c
			t.mu.Lock()
			if t.closed {
				t.mu.Unlock()
				_ = c.Close()
				return
			}
			t.conn = c
			t.mu.Unlock()
		}
	}
	if conn == nil {
		return
	}
	for _, ev := range batch {
		if ev.lostBefore > 0 && writeFrame(conn, event{method: "tap.dropped", payload: []byte(fmt.Sprintf(`{"events":%d}`, ev.lostBefore))}) != nil {
			t.disconnect(conn)
			return
		}
		if writeFrame(conn, ev) != nil {
			t.disconnect(conn)
			return
		}
		written++
	}
}

func (t *tap) disconnect(conn net.Conn) {
	_ = conn.Close()
	t.mu.Lock()
	if t.conn == conn {
		t.conn = nil
	}
	t.mu.Unlock()
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

// shutdown stops admission, releases queued payloads and stops the writer.
// The host keeps unloaded libraries mapped, so nothing may stay referenced
// and no goroutine may outlive this call.
func (t *tap) shutdown() {
	t.mu.Lock()
	t.closed = true
	for _, ev := range t.queue {
		t.pending -= len(ev.payload)
		t.lost += ev.lostBefore + 1
	}
	t.queue = nil
	running, stop, done, conn := t.running, t.stop, t.done, t.conn
	t.mu.Unlock()
	if !running {
		return
	}
	select {
	case <-stop: // an earlier shutdown already stopped this writer
	default:
		close(stop)
	}
	if conn != nil {
		_ = conn.Close() // interrupts a write in progress
	}
	select {
	case <-done:
	case <-time.After(shutdownWait):
	}
}
