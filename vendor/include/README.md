# @cordisjs/plugin-include

File-backed loader tree for Cordis. The include plugin reads a YAML or JSON
file, turns it into loader entries, and writes updates back when the file is
writable.

## Usage

```ts
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'

const root = new Context()
await root.plugin(Loader, { baseUrl: import.meta.url })
await root.plugin(Include, {
  path: './cordis.yml',
  initial: [],
  enableLogs: true,
})
```

Example `cordis.yml`:

```yaml
- id: timer
  name: '@cordisjs/plugin-timer'
- id: app
  name: ./plugins/app
  config:
    message: hello
```

## Config

| Field | Description |
| --- | --- |
| `path` | YAML or JSON file path resolved from `ctx.baseUrl`. |
| `initial` | Entry list written when the file is missing. |
| `patches` | Runtime patches applied after reading the file. |
| `enableLogs` | Enables loader apply, reload, and unload logs. |

Patches can insert entries or override fields on entries with a matching `id`.

## Native document source

A launcher can bind `EntryDocumentSource` before mounting Includes. Each read carries its native publication closure and an explicit `persist`, `readonly` or `discard` disposition. Logical filenames remain the module-resolution base; managed reads and writes never fall back to original files. Managed refresh errors reach the caller, and source retirement cannot restore file-backed behavior. Root Profile composition uses `discard`. Nested writes derive only source-owned fields from the composed before/after entries, retain unchanged YAML comments and `!!js` nodes, and reapply patches before publishing. Changes owned by an overlay refuse instead of being baked into the source. No native storage provider or enrollment is installed by Include.
