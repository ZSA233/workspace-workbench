package compat

import (
	"encoding/json"
	"testing"
)

func TestJavaScriptStringEscaping(t *testing.T) {
	for _, value := range []string{"中文😀<>&\u2028\u2029", `literal\u2028`, "line\n\t\x00\b\f\r"} {
		b := Stringify(value)
		var decoded string
		if e := json.Unmarshal(b, &decoded); e != nil || decoded != value {
			t.Fatalf("%q %s %v", value, b, e)
		}
	}
	if got := string(Stringify(Ordered{{"z", 1}, {"a", 2}})); got != `{"z":1,"a":2}` {
		t.Fatal(got)
	}
}

func TestOrderedDecoderRejectsTrailingJSON(t *testing.T) {
	if _, e := ParseOrdered([]byte(`{} {}`)); e == nil {
		t.Fatal("accepted concatenated JSON")
	}
}
