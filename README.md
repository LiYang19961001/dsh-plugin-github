# dsh-plugin-github

GitHub tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Registers four model-facing tools that talk to the GitHub REST API using the token already
configured on the machine. No server, no OAuth dance, no extra daemon.

## Tools

| Tool | What it does |
|---|---|
| `github_whoami` | Who the token belongs to, its OAuth scopes, remaining REST rate limit. |
| `github_request` | One arbitrary REST call: `method` + `path` + optional `query` / `body`. Covers repositories, issues, pull requests, releases, workflows, SSH keys, and everything else the API exposes. |
| `github_search` | Search repositories, issues and pull requests, code, users, or commits. |
| `github_file_read` | Read one repository file, decoded as UTF-8, with its blob sha and size. |

`github_request` is the general-purpose escape hatch: anything the narrower tools do not
cover is one call away. Writing files is `PUT /repos/{owner}/{repo}/contents/{path}` with
`{"message": "...", "content": "<base64>"}`.

## Credential resolution

The token is read lazily per call, in this order:

1. `GH_TOKEN`
2. `GITHUB_TOKEN`
3. `~/.dsh/github/token` — the file the standalone `gh.py` bridge on this machine uses

One token therefore drives both the plugin and any scripts that already read that file.
A classic PAT with `repo` + `workflow` + `read:org` covers everyday work; add
`admin:public_key` to read or manage SSH keys and `delete_repo` to delete repositories.

## Install

From the Plugins page, add this market index URL in **Discover → Add index source**:

```
https://liyang19961001.github.io/dsh-plugin-market/index.json
```

Then install the **GitHub** entry. Equivalent manual install, if you prefer a shell:

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "git+https://github.com/LiYang19961001/dsh-plugin-github.git#<commit>"
```

and add the row to the profile's `cordis.patch.yml`:

```yaml
- id: plugin-github
  name: dsh-plugin-github
  config: {}
```

## Safety

- Every request is pinned to `https://api.github.com`. `path` must be relative, so the tool
  cannot be aimed at another host and cannot be used to send the token somewhere else.
- The token is never returned in tool output.
- `github_request` can mutate state (POST/PATCH/PUT/DELETE). It inherits whatever session
  permission policy DSH is running with; the tool itself does not ask for confirmation.
  Use a token scoped no wider than the job needs.

## Layout

```
package.json        dsh.bundle.patch points at cordis.patch.yml
cordis.patch.yml    inserts the single Host row that registers the tools
index.js            the Cordis plugin: inject ['tools'], export apply/name
icon.svg            market icon
```

## License

MIT
