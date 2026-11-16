---
type: devlog
project: 
created: <% tp.date.now("YYYY-MM-DD") %>
tags:
  - devlog
---

# Development Log

Each session has its own note in the devlog folder next to this one; the table lists them newest first.

```base
filters:
  and:
    - file.inFolder("<% devlog_folder %>")
views:
  - type: table
    name: Sessions
    order:
      - file.name
      - type
      - file.mtime
    sort:
      - property: file.name
        direction: DESC
```
