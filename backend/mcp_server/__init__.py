"""Collection-aware MCP server (remote, Streamable HTTP at /mcp).

`tools.py` holds the owner-scoped read logic and imports nothing from the MCP
SDK, so it is testable without it; `app.py` wires it into `mcp.MCPServer`.
"""
