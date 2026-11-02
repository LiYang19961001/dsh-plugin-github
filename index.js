/**
 * dsh-plugin-github — model-facing GitHub tools for DeepSeek Harness.
 *
 * Registers four tools on `ctx.tools`:
 *   github_whoami      who the configured token belongs to, its scopes, rate limit
 *   github_request     one arbitrary GitHub REST call (method + path + optional query/body)
 *   github_search      repository / issue / code / user search
 *   github_file_read   read one repository file, decoded as UTF-8
 *
 * Credential resolution mirrors the standalone `gh.py` bridge on the same machine, so one
 * token serves both: GH_TOKEN / GITHUB_TOKEN, then ~/.dsh/github/token.
 *
 * Every request is pinned to https://api.github.com. A relative path is required, so the
 * tool cannot be pointed at an arbitrary host and cannot exfiltrate the token elsewhere.
 *
 * @module dsh-plugin-github
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'plugin-github'

/** The tool registry is the only service this plugin needs. */
export const inject = ['tools']

const API_ORIGIN = 'https://api.github.com'
const USER_AGENT = 'dsh-plugin-github/1.0'
const DEFAULT_TIMEOUT_MS = 30_000

const TOKEN_FILE = path.join(os.homedir(), '.dsh', 'github', 'token')

/**
 * Resolve the GitHub token from the environment or the shared token file.
 * @returns {{ token: string, source: string }}
 * @throws when no credential is configured, with the exact path it looked for.
 */
function resolveToken() {
  for (const envName of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[envName]
    if (value && value.trim() !== '') return { token: value.trim(), source: `env:${envName}` }
  }
  try {
    const text = fs.readFileSync(TOKEN_FILE, 'utf8')
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed !== '' && !trimmed.startsWith('#')) {
        return { token: trimmed, source: `file:${TOKEN_FILE}` }
      }
    }
  } catch {
    // fall through to the shared error below
  }
  throw new Error(
    `No GitHub token configured. Set GH_TOKEN / GITHUB_TOKEN, or write the raw token to ${TOKEN_FILE}`,
  )
}

/** JSON pretty-print used for every tool result. */
function asText(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Normalize and validate a caller-supplied REST path.
 * @param raw - the path, which must be absolute and stay on api.github.com.
 * @returns the path with a leading slash and no scheme or host.
 */
function normalizePath(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') throw new Error('`path` must be a non-empty REST path such as /repos/owner/repo')
  if (/^[a-z][a-z0-9+.-]*:/iu.test(text) || text.startsWith('//')) {
    throw new Error('`path` must be a path relative to https://api.github.com (no scheme, no host)')
  }
  return text.startsWith('/') ? text : `/${text}`
}

/**
 * Perform one GitHub REST request.
 * @param method - HTTP method.
 * @param restPath - path relative to api.github.com.
 * @param options - optional query object and JSON body.
 * @returns the status, headers of interest, and parsed payload.
 */
async function request(method, restPath, { query, body, accept, signal } = {}) {
  const { token } = resolveToken()
  const url = new URL(API_ORIGIN + restPath)
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item))
      else url.searchParams.append(key, String(value))
    }
  }

  const headers = {
    accept: accept ?? 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': USER_AGENT,
    'x-github-api-version': '2022-11-28',
  }

  let payload
  if (body !== undefined && body !== null) {
    headers['content-type'] = 'application/json'
    payload = typeof body === 'string' ? body : JSON.stringify(body)
  }

  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  const init = { method: method.toUpperCase(), headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }
  if (payload !== undefined) init.body = payload

  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new Error(`GitHub request failed before a response: ${error?.message ?? String(error)}`)
  }

  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  let data
  if (contentType.includes('application/json')) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  } else {
    data = text
  }

  return {
    ok: response.ok,
    status: response.status,
    scopes: response.headers.get('x-oauth-scopes'),
    rateRemaining: response.headers.get('x-ratelimit-remaining'),
    rateLimit: response.headers.get('x-ratelimit-limit'),
    url: url.toString(),
    data,
  }
}

/** Shared `output` declaration: the canonical value is a JSON text block. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * Register the github_* tools.
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'github_whoami',
      description:
        'Identify the GitHub account behind the configured token and report its OAuth scopes and remaining REST rate limit. Use this to check whether GitHub access is available before other github_ tools.',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute(_args, exec) {
        const me = await request('GET', '/user', { signal: exec.signal })
        if (!me.ok) return asText({ ok: false, status: me.status, error: me.data })
        const user = me.data ?? {}
        return asText({
          ok: true,
          login: user.login,
          name: user.name ?? null,
          id: user.id,
          html_url: user.html_url,
          public_repos: user.public_repos,
          scopes: me.scopes,
          rate_remaining: me.rateRemaining,
          rate_limit: me.rateLimit,
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_request',
      description:
        'Call the GitHub REST API once. Use this for anything the other github_ tools do not cover: repositories, issues, pull requests, releases, workflows, SSH keys. Returns the HTTP status, OAuth scopes, rate limit, and the parsed JSON body. The path is relative to https://api.github.com.',
      parameters: {
        method: {
          type: 'string',
          required: true,
          enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
          description: 'HTTP method. Use GET to read, POST to create, PATCH to update, DELETE to remove.',
        },
        path: {
          type: 'string',
          required: true,
          description: 'REST path relative to api.github.com, e.g. /repos/owner/repo or /user/repos.',
        },
        query: {
          type: 'string',
          description: 'Optional JSON object of query parameters, e.g. {"per_page":10,"state":"open"}.',
        },
        body: {
          type: 'string',
          description: 'Optional JSON object sent as the request body.',
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        let query
        if (args.query !== undefined && String(args.query).trim() !== '') {
          try {
            query = JSON.parse(args.query)
          } catch (error) {
            throw new Error(`\`query\` must be a JSON object: ${error?.message ?? String(error)}`)
          }
        }
        let body
        if (args.body !== undefined && String(args.body).trim() !== '') {
          try {
            body = JSON.parse(args.body)
          } catch (error) {
            throw new Error(`\`body\` must be a JSON object: ${error?.message ?? String(error)}`)
          }
        }
        const result = await request(args.method, normalizePath(args.path), {
          query,
          body,
          signal: exec.signal,
        })
        return asText(result)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_search',
      description:
        'Search GitHub repositories, issues and pull requests, code, users, or commits. Returns the top matches with the fields needed to follow up on them.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'GitHub search syntax, e.g. "language:typescript stars:>500" or "repo:owner/repo is:open label:bug".',
        },
        type: {
          type: 'string',
          required: true,
          enum: ['repositories', 'issues', 'code', 'users', 'commits'],
          description: 'Which GitHub search endpoint to use.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum results to return, 1-30. Defaults to 10.',
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 30)
        const result = await request('GET', `/search/${args.type}`, {
          query: { q: args.query, per_page: limit },
          signal: exec.signal,
        })
        if (!result.ok) return asText(result)

        const items = result.data?.items ?? []
        const project = (item) => {
          switch (args.type) {
            case 'repositories':
              return {
                full_name: item.full_name,
                description: item.description,
                stars: item.stargazers_count,
                language: item.language,
                updated_at: item.updated_at,
                html_url: item.html_url,
              }
            case 'issues':
              return {
                number: item.number,
                title: item.title,
                state: item.state,
                repo: item.repository_url?.split('/repos/')[1] ?? null,
                html_url: item.html_url,
              }
            case 'code':
              return { path: item.path, repo: item.repository?.full_name ?? null, html_url: item.html_url }
            case 'users':
              return { login: item.login, type: item.type, html_url: item.html_url }
            default:
              return {
                sha: item.sha,
                message: item.commit?.message?.split('\n')[0] ?? null,
                repo: item.repository?.full_name ?? null,
                html_url: item.html_url,
              }
          }
        }

        return asText({
          ok: true,
          status: result.status,
          total_count: result.data?.total_count ?? items.length,
          returned: items.length,
          items: items.map(project),
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_file_read',
      description:
        'Read one file from a GitHub repository and return its UTF-8 text plus blob sha and size. Use github_request with PUT /repos/{owner}/{repo}/contents/{path} to write files instead.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner.' },
        repo: { type: 'string', required: true, description: 'Repository name.' },
        path: { type: 'string', required: true, description: 'File path inside the repository, e.g. README.md.' },
        ref: { type: 'string', description: 'Optional branch, tag, or commit sha. Defaults to the default branch.' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const owner = encodeURIComponent(args.owner)
        const repo = encodeURIComponent(args.repo)
        const filePath = args.path
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')
        const result = await request('GET', `/repos/${owner}/${repo}/contents/${filePath}`, {
          query: args.ref ? { ref: args.ref } : undefined,
          signal: exec.signal,
        })
        if (!result.ok) return asText(result)

        const entry = result.data
        if (Array.isArray(entry)) {
          return asText({
            ok: false,
            status: result.status,
            error: 'the path names a directory, not a file',
            entries: entry.map((item) => ({ name: item.name, type: item.type, path: item.path })),
          })
        }
        const base64 = entry?.content?.replace(/\n/gu, '') ?? ''
        const content = base64 === '' ? '' : Buffer.from(base64, 'base64').toString('utf8')
        return asText({
          ok: true,
          status: result.status,
          path: entry?.path ?? args.path,
          sha: entry?.sha ?? null,
          size: entry?.size ?? null,
          encoding: entry?.encoding ?? null,
          content,
        })
      },
    }),
  )
}
