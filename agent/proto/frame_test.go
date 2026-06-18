package proto

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	cases := []Frame{
		{Type: Control, StreamID: 0, Payload: []byte(`{"event":"hello"}`)},
		{Type: Stdout, StreamID: 7, Payload: []byte("hello stdout")},
		{Type: Stderr, StreamID: 7, Payload: []byte("oops")},
		{Type: EOF, StreamID: 7, Payload: nil},
		{Type: ResultFrame, StreamID: 7, Payload: []byte(`{"ok":true}`)},
		{Type: Close, StreamID: 42, Payload: nil},
	}
	var buf bytes.Buffer
	fw := NewFrameWriter(&buf)
	for _, c := range cases {
		if err := fw.Write(c.Type, c.StreamID, c.Payload); err != nil {
			t.Fatalf("write %v: %v", c.Type, err)
		}
	}
	for i, want := range cases {
		got, err := ReadFrame(&buf)
		if err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
		if got.Type != want.Type || got.StreamID != want.StreamID {
			t.Fatalf("frame %d: got %v/%d want %v/%d", i, got.Type, got.StreamID, want.Type, want.StreamID)
		}
		if !bytes.Equal(got.Payload, want.Payload) {
			t.Fatalf("frame %d payload: got %q want %q", i, got.Payload, want.Payload)
		}
	}
	if _, err := ReadFrame(&buf); err != io.EOF {
		t.Fatalf("expected clean EOF at boundary, got %v", err)
	}
}

func TestReadFrameTruncated(t *testing.T) {
	var buf bytes.Buffer
	NewFrameWriter(&buf).Write(Stdout, 1, []byte("abcdef"))
	truncated := buf.Bytes()[:HeaderSize+2] // header + 2 of 6 payload bytes
	if _, err := ReadFrame(bytes.NewReader(truncated)); err != io.ErrUnexpectedEOF {
		t.Fatalf("expected ErrUnexpectedEOF on truncated payload, got %v", err)
	}
}

func TestReadFramePayloadTooLarge(t *testing.T) {
	var hdr [HeaderSize]byte
	binary.BigEndian.PutUint32(hdr[0:4], MaxPayload+1)
	hdr[4] = byte(Stdout)
	if _, err := ReadFrame(bytes.NewReader(hdr[:])); err != ErrPayloadTooLarge {
		t.Fatalf("expected ErrPayloadTooLarge, got %v", err)
	}
}

func TestWriteFramePayloadTooLarge(t *testing.T) {
	var buf bytes.Buffer
	err := NewFrameWriter(&buf).Write(Stdout, 1, make([]byte, MaxPayload+1))
	if err != ErrPayloadTooLarge {
		t.Fatalf("expected ErrPayloadTooLarge, got %v", err)
	}
}
