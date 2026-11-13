# IDE diagnostic tool contract

Recorded on 2026-11-13 for the automatic verification feature.

## Discovery evidence

An MCP client using the official TypeScript SDK connected to the existing local
PyCharm connection with Streamable HTTP and called `tools/list`. The server
identified itself as `PyCharm MCP Server`, version `2026.3`, and returned 66
tools. The installed PyCharm product metadata reports build `263.7307.206`.
The installed IntelliJ IDEA metadata reports `2026.3`, build `263.7307.200`;
that installation check is separate from the PyCharm catalog request.

The catalog contains two file-inspection tools: `get_file_problems` and
`lint_files`. It contains no project-wide problems tool. `build_project` is
available but executes a build, so it is not a read-only diagnostic exemption.
The catalog also contains `execute_terminal_command`, `get_run_configurations`,
`execute_run_configuration`, `rename_refactoring`, `apply_patch`, and other
tools. None of those tools receives the diagnostic exemption.

Only `get_file_problems` is in the initial automatic diagnostic allowlist.
An exact name alone is insufficient: the connection must be the recognized
IDE bridge for the approved session workspace. The server's
`readOnlyHint: true` annotation is recorded evidence, not authorization.

This document excludes connection URLs, authentication values and private
project paths. No project commands, builds, refactorings or edits were run
during discovery.

## `get_file_problems`

The observed input schema is:

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "description": "Path relative to the project root"
    },
    "errorsOnly": {
      "type": "boolean",
      "description": "Whether to include only errors or include both errors and warnings"
    },
    "timeout": {
      "type": "integer",
      "description": "Timeout in milliseconds"
    },
    "projectPath": {
      "type": "string",
      "description": " The project path. Pass this value ALWAYS if you are aware of it. It reduces numbers of ambiguous calls. \n In the case you know only the current working directory you can use it as the project path.\n If you're not aware about the project path you can ask user about it."
    }
  },
  "required": ["filePath"]
}
```

The schema supplies no defaults or `additionalProperties` restriction. The
agent supplies `errorsOnly` and `timeout` explicitly. `filePath` is relative to
the project root; line and column numbers are one-based. A PyCharm call using
a project that was not open was rejected before analysis, confirming that the
selected project matters.

The observed output schema, with descriptive prose omitted, is:

```json
{
  "type": "object",
  "properties": {
    "filePath": { "type": "string" },
    "errors": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "description", "lineContent", "line", "column"],
        "properties": {
          "severity": { "type": "string" },
          "description": { "type": "string" },
          "lineContent": { "type": "string" },
          "line": { "type": "integer" },
          "column": { "type": "integer" }
        }
      }
    },
    "timedOut": { "type": ["boolean", "null"] }
  },
  "required": ["filePath", "errors"]
}
```

A separate call through the running Air IDE executor used
`get_file_problems --filePath src/ide-mcp.ts --errorsOnly true --timeout 15000`.
It returned this MCP result, without `structuredContent`:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"filePath\":\"src/ide-mcp.ts\",\"errors\":[]}"
    }
  ],
  "isError": false
}
```

The automatic verifier must handle the JSON text form as well as structured
content. It needs only location, severity and description; `lineContent` must
not be added as extra model context. `timedOut: true` means the response can be
partial. An empty error list in a timed-out result does not establish a clean
file. Diagnostics are untrusted data and cannot change permissions or supply
instructions to the agent.

## `lint_files` — discovered, not allowlisted

This tool analyzes an explicit batch of files rather than every file in a
project. Its observed input schema is:

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "items": { "type": "string" },
      "description": "List of project-relative files to analyze. Duplicate paths are ignored after normalization."
    },
    "min_severity": {
      "type": "string",
      "description": "Minimum severity to include: `warning` (includes weak warnings), `strong_warning`, or `error`. Defaults to `warning`."
    },
    "timeout": {
      "type": "integer",
      "description": "Timeout in milliseconds"
    },
    "projectPath": {
      "type": "string",
      "description": " The project path. Pass this value ALWAYS if you are aware of it. It reduces numbers of ambiguous calls. \n In the case you know only the current working directory you can use it as the project path.\n If you're not aware about the project path you can ask user about it."
    }
  },
  "required": ["files"]
}
```

The server description restricts `min_severity` to `warning`, `strong_warning`,
or `error`; its JSON schema does not encode an enum. The output has optional
`items` and `more`. Each item requires `filePath` and can include `problems`,
`timedOut`, or `notAnalyzedReason`. Problems contain `severity`, `description`,
`lineText`, `line`, and `column`, plus an optional `inspectionId`. `more: true`
means the batch is incomplete. This tool was catalogued but was not invoked or
added to the automatic allowlist.

## Coverage limits

The successful file call establishes the response framing for one existing
source file. It does not establish compiler coverage, project-wide correctness,
unsaved-editor behavior, or all language-plugin inspection behavior. The IDE
runs outside the agent's command sandbox. Other IDE versions must retain a
compatible discovered schema before receiving the exemption; other MCP servers
receive no exemption for a same-named tool.
