// Command checkmoney rejects floating-point types and casts in Go money code.
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: checkmoney <money-package-directory>")
		os.Exit(2)
	}

	root := os.Args[1]
	fset := token.NewFileSet()
	found := false
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" {
			return nil
		}

		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(node ast.Node) bool {
			ident, ok := node.(*ast.Ident)
			if !ok || (ident.Name != "float32" && ident.Name != "float64") {
				return true
			}
			position := fset.Position(ident.Pos())
			fmt.Fprintf(os.Stderr, "%s:%d: forbidden monetary type %s\n", position.Filename, position.Line, ident.Name)
			found = true
			return true
		})
		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "checkmoney: %v\n", err)
		os.Exit(2)
	}
	if found {
		os.Exit(1)
	}
}
