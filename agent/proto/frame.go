// Package proto is the wire protocol spoken between the daemon's microVM drivers
// (host) and the in-sandbox hotcell-agent (guest) over a single vsock connection.
//
// It is a small, framed, multiplexed binary protocol. One connection carries
// many concurrent logical streams (one per in-flight exec / pty / file / relay
// request), distinguished by a streamId. The framing deliberately mirrors the
// daemon's existing wire vocabulary (ExecEvent's stdout/stderr/exit, FileInfo,
// SandboxStats) so the REST → SSE → SDK layers above the driver are unchanged
// when a microVM driver is swapped in for the container driver.
//
// Frame layout (all integers big-endian):
//
//	[u32 length][u8 type][u32 streamId][payload (length bytes)]
//
// length is the byte length of payload only; the 9-byte header is fixed.
package proto

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"
)

// FrameType identifies a frame's role on its stream.
//
// The plan (docs/plan.md A.4) names the set {OPEN, DATA, EOF, CLOSE, CONTROL,
// RESULT}. We refine the single "DATA" into directional, channel-tagged frames
// (Stdin / Stdout / Stderr) so exec's two output channels map cleanly onto the
// daemon's ExecEvent without an extra in-band channel byte. OPEN is folded into
// Control (a Control frame on a fresh streamId opens that stream).
type FrameType uint8

const (
	// Control carries a JSON request (host→guest) or a control message
	// (resize / cancel). A Control frame on a not-yet-seen streamId opens that
	// stream. The guest also sends one unsolicited Control frame on stream 0 at
	// connect time: the Hello greeting the host waits for.
	Control FrameType = 1
	// Stdin carries input bytes host→guest (exec/pty stdin, untar payload).
	Stdin FrameType = 2
	// Stdout carries output bytes guest→host (exec stdout, pty output, log tail,
	// tcp-relay bytes, tar payload).
	Stdout FrameType = 3
	// Stderr carries exec stderr bytes guest→host.
	Stderr FrameType = 4
	// EOF marks the end of input on a stream (host→guest, e.g. stdin closed) or
	// the end of streamed output (guest→host) ahead of the terminal Result.
	EOF FrameType = 5
	// ResultFrame is the terminal JSON outcome of a request (guest→host):
	// ok/error, an optional exit code, and an optional return value. It closes
	// the stream. (Named with the Frame suffix to avoid colliding with the
	// Result message struct in messages.go.)
	ResultFrame FrameType = 6
	// Close tears down a stream from either side (e.g. the host aborts a watch
	// or the client disconnects from a pty). No payload.
	Close FrameType = 7
)

func (t FrameType) String() string {
	switch t {
	case Control:
		return "CONTROL"
	case Stdin:
		return "STDIN"
	case Stdout:
		return "STDOUT"
	case Stderr:
		return "STDERR"
	case EOF:
		return "EOF"
	case ResultFrame:
		return "RESULT"
	case Close:
		return "CLOSE"
	default:
		return fmt.Sprintf("FrameType(%d)", uint8(t))
	}
}

// HeaderSize is the fixed per-frame header length in bytes.
const HeaderSize = 9

// MaxPayload bounds a single frame's payload so a malformed or hostile length
// can't make the agent allocate unbounded memory. Larger transfers stream as
// many frames. 16 MiB matches the daemon's default max body size ballpark.
const MaxPayload = 16 << 20

// ErrPayloadTooLarge is returned by ReadFrame when a frame's declared length
// exceeds MaxPayload.
var ErrPayloadTooLarge = errors.New("proto: frame payload exceeds maximum")

// Frame is a single decoded protocol frame.
type Frame struct {
	Type     FrameType
	StreamID uint32
	Payload  []byte
}

// ReadFrame reads exactly one frame from r. It returns io.EOF only when r is at
// a clean frame boundary; a truncated frame yields io.ErrUnexpectedEOF.
func ReadFrame(r io.Reader) (Frame, error) {
	var hdr [HeaderSize]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return Frame{}, err
	}
	length := binary.BigEndian.Uint32(hdr[0:4])
	if length > MaxPayload {
		return Frame{}, ErrPayloadTooLarge
	}
	f := Frame{
		Type:     FrameType(hdr[4]),
		StreamID: binary.BigEndian.Uint32(hdr[5:9]),
	}
	if length > 0 {
		f.Payload = make([]byte, length)
		if _, err := io.ReadFull(r, f.Payload); err != nil {
			if err == io.EOF {
				err = io.ErrUnexpectedEOF
			}
			return Frame{}, err
		}
	}
	return f, nil
}

// FrameWriter serializes frames onto an io.Writer. Writes are mutex-guarded so
// frames from concurrent stream goroutines never interleave mid-frame.
type FrameWriter struct {
	mu sync.Mutex
	w  io.Writer
}

// NewFrameWriter wraps w.
func NewFrameWriter(w io.Writer) *FrameWriter {
	return &FrameWriter{w: w}
}

// Write emits one frame atomically.
func (fw *FrameWriter) Write(t FrameType, streamID uint32, payload []byte) error {
	if len(payload) > MaxPayload {
		return ErrPayloadTooLarge
	}
	var hdr [HeaderSize]byte
	binary.BigEndian.PutUint32(hdr[0:4], uint32(len(payload)))
	hdr[4] = byte(t)
	binary.BigEndian.PutUint32(hdr[5:9], streamID)

	fw.mu.Lock()
	defer fw.mu.Unlock()
	if _, err := fw.w.Write(hdr[:]); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := fw.w.Write(payload); err != nil {
			return err
		}
	}
	return nil
}
