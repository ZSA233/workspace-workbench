package compat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

func (o Ordered) MarshalJSON() ([]byte, error) { return Stringify(o), nil }

// ParseOrdered is used only where v1 converted a source JSON object to message text.
func ParseOrdered(data []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	value, e := orderedValue(d)
	if e != nil {
		return nil, e
	}
	if _, e = d.Token(); e != io.EOF {
		return nil, fmt.Errorf("invalid_json")
	}
	return value, nil
}
func orderedValue(d *json.Decoder) (any, error) {
	token, e := d.Token()
	if e != nil {
		return nil, e
	}
	if delimiter, ok := token.(json.Delim); ok {
		switch delimiter {
		case '{':
			out := Ordered{}
			for d.More() {
				key, e := d.Token()
				if e != nil {
					return nil, e
				}
				v, e := orderedValue(d)
				if e != nil {
					return nil, e
				}
				out = append(out, Field{key.(string), v})
			}
			_, e = d.Token()
			return out, e
		case '[':
			out := []any{}
			for d.More() {
				v, e := orderedValue(d)
				if e != nil {
					return nil, e
				}
				out = append(out, v)
			}
			_, e = d.Token()
			return out, e
		default:
			return nil, fmt.Errorf("invalid_json")
		}
	}
	return token, nil
}
