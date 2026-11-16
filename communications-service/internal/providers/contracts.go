package providers

import (
	"context"
	p "github.com/zsa233/workspace-workbench/communications-service/internal/protocol"
)

type SourcePage struct {
	Messages []p.Message
	Complete bool
	Cursor   string
	Error    string
}
type SourceProvider interface {
	Check(context.Context) (p.Record, error)
	Authorize(context.Context, func(string)) error
	SearchGroups(context.Context, string) ([]p.Record, error)
	VerifyMembership(context.Context, p.Group) (bool, error)
	Read(context.Context, p.Group, int64, int64, string) (SourcePage, error)
	Subscribe(context.Context, p.Group, func(p.Message), func(), func(error)) (func(), error)
	Download(context.Context, p.Message, p.Record) ([]byte, string, error)
	Close()
}
type Image struct {
	ID, MimeType string
	Bytes        []byte
}
type AnalysisInput struct {
	Messages     []p.Message
	Requirements []p.Requirement
	Config       p.Config
	Summary      string
	Images       []Image
}
type AnalysisResult struct {
	Proposals       []p.Candidate
	Summary         string
	EstimatedTokens int
}
type AnalysisProvider interface {
	Models(context.Context) ([]p.Record, error)
	Check(context.Context) error
	Analyze(context.Context, AnalysisInput) (AnalysisResult, error)
}
type RetrievalProvider interface {
	SearchMessages(context.Context, string, int) ([]p.Message, error)
	RelatedRequirements(context.Context, string, int) ([]p.Requirement, error)
}
type Limits struct {
	DWS        chan struct{}
	Generation chan struct{}
}

func NewLimits() *Limits { return &Limits{make(chan struct{}, 4), make(chan struct{}, 1)} }
func Acquire(ctx context.Context, ch chan struct{}) (func(), error) {
	select {
	case ch <- struct{}{}:
		return func() { <-ch }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
