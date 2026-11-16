package protocol

import (
	"encoding/json"
	"github.com/zsa233/workspace-workbench/communications-service/internal/compat"
	"os"
	"reflect"
	"testing"
)

func TestNodeProtocolFixtures(t *testing.T) {
	b, e := os.ReadFile("../../testdata/protocol-v1.json")
	if e != nil {
		t.Fatal(e)
	}
	wrapped, e := Decode(append(append([]byte(`{"items":`), b...), '}'))
	if e != nil {
		t.Fatal(e)
	}
	for i, item := range wrapped.Records("items") {
		a, e := ParseAction(item.O("input"))
		if (e == nil) != item.B("valid") {
			t.Fatalf("case %d: %v", i, e)
		}
		if e == nil {
			got, _ := Decode(compat.JSON(a.Values))
			want := item.O("output")
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("case %d: got %s want %s", i, compat.JSON(got), compat.JSON(want))
			}
		}
	}
}
func TestConfigAndActionBounds(t *testing.T) {
	for _, s := range []string{`{"model":null}`, `{"model":{"vision":null}}`, `{"analysis":{"categories":[]}}`, `{"source":{"mode":"other"}}`, `{"model":{"baseUrl":"http://user:pass@localhost"}}`} {
		r, _ := Decode([]byte(s))
		if _, e := ParseConfig(r); e == nil {
			t.Fatal(s)
		}
	}
	r, _ := Decode([]byte(`{"action":"messages.list","limit":50.0}`))
	if _, e := ParseAction(r); e != nil {
		t.Fatal(e)
	}
	var c any
	json.Unmarshal([]byte(`{"model":{"contextTokens":524288,"modelLimit":524288}}`), &c)
	if _, e := ParseConfig(c); e != nil {
		t.Fatal(e)
	}
}

func TestDecodeRejectsTrailingAndNonObjectInput(t *testing.T) {
	for _, raw := range []string{`{} {}`, `{} garbage`, `[]`, `null`} {
		if _, e := Decode([]byte(raw)); e == nil {
			t.Fatal(raw)
		}
	}
}
