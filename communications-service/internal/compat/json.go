// Package compat preserves v1 identities produced by JavaScript JSON.stringify.
package compat

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
)

type Field struct {
	Key   string
	Value any
}
type Ordered []Field

func JSON(value any) []byte {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(value); err != nil {
		panic(err)
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}
func Stringify(value any) []byte {
	if fields, ok := value.(Ordered); ok {
		var b bytes.Buffer
		b.WriteByte('{')
		for i, f := range fields {
			if i > 0 {
				b.WriteByte(',')
			}
			b.Write(Stringify(f.Key))
			b.WriteByte(':')
			b.Write(Stringify(f.Value))
		}
		b.WriteByte('}')
		return b.Bytes()
	}
	if values, ok := value.([]any); ok {
		var b bytes.Buffer
		b.WriteByte('[')
		for i, v := range values {
			if i > 0 {
				b.WriteByte(',')
			}
			b.Write(Stringify(v))
		}
		b.WriteByte(']')
		return b.Bytes()
	}
	if values, ok := value.([]string); ok {
		a := make([]any, len(values))
		for i, v := range values {
			a[i] = v
		}
		return Stringify(a)
	}
	if s, ok := value.(string); ok {
		var b bytes.Buffer
		b.WriteByte('"')
		for _, c := range s {
			switch c {
			case '"':
				b.WriteString(`\"`)
			case '\\':
				b.WriteString(`\\`)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				if c < 32 {
					fmt.Fprintf(&b, `\u%04x`, c)
				} else {
					b.WriteRune(c)
				}
			}
		}
		b.WriteByte('"')
		return b.Bytes()
	}
	if n, ok := value.(json.Number); ok {
		f, e := strconv.ParseFloat(string(n), 64)
		if e != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			return []byte("null")
		}
		if f == 0 {
			return []byte("0")
		}
		return JSON(f)
	}
	return JSON(value)
}
func Hash(value any) string        { return HashBytes(Stringify(value)) }
func HashBytes(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
