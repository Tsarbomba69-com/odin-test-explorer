# Odin Test Explorer

Odin Test Explorer integrates Odin test procedures with the Visual Studio Code Test Explorer.

It discovers `@(test)` procedures in `.odin` files, displays them in package and file groups, and runs them through the Odin compiler.

## Features

- Discover tests in `**/*.odin` files
- Support for `@test`, `@(test)`, and annotations containing `test`
- Automatic updates when Odin files are created, changed, or deleted
- Package-level test grouping
- Odin test failure locations linked back to source files
- Configurable Odin executable and test arguments
- Optional Odin memory tracking

## Example

```odin
@test
test_add :: proc(t: ^testing.T) {
    testing.expect(t, 1 + 1 == 2)
}
```

## Requirements

- Visual Studio Code 1.85 or newer
- Odin available on your system
- An Odin project opened in a VS Code workspace

## Installation

Clone the repository:

```bash
git clone https://github.com/Tsarbomba69-com/odin-test-explorer.git
cd odin-test-explorer
```

Install dependencies:

```bash
pnpm install
```

Compile the extension:

```bash
pnpm run compile
```

Press `F5` in VS Code to open a new Extension Development Host window.

## Usage

1. Open an Odin workspace.
2. Open the **Testing** view in VS Code.
3. Refresh tests or wait for automatic discovery.
4. Run individual tests, files, packages, or the complete discovered test set.

Tests are run with:

```bash
odin test <package-directory>
```

## Configuration

Configure Odin Test Explorer in VS Code settings:

| Setting | Default | Description |
| --- | --- | --- |
| `odinTestExplorer.odinPath` | `odin` | Path to the Odin compiler executable |
| `odinTestExplorer.trackMemory` | `true` | Enables `ODIN_TEST_TRACK_MEMORY` |
| `odinTestExplorer.extraArgs` | `[]` | Additional arguments passed to `odin test` |

Example:

```json
{
    "odinTestExplorer.odinPath": "/usr/local/bin/odin",
    "odinTestExplorer.trackMemory": true,
    "odinTestExplorer.extraArgs": [
        "-collection:shared=src/shared"
    ]
}
```

## Development

Compile TypeScript:

```bash
pnpm run compile
```

Watch for changes:

```bash
pnpm run watch
```

The compiled extension entry point is generated at:

```text
out/extension.js
```

## Project Structure

```text
.
├── src/
│   └── extension.ts
├── package.json
├── tsconfig.json
├── pnpm-lock.yaml
└── LICENSE
```

## License

Licensed under the [MIT License](LICENSE).

Copyright (c) 2026 Hendrick Dias
