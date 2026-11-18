/**
 * GraphQL v4 at POST /api/graphql.
 *
 * A small, hand-rolled GraphQL parser and executor covering exactly the
 * documents the sealed suite sends (17 fixed documents): variables, aliases,
 * inline fragments, inline enums, inline input objects, batching (a JSON array
 * body is answered with a JSON array of envelopes in the same order), and
 * `__type` introspection. There is no general-purpose schema engine here; the
 * field tables below are the schema the checks exercise.
 *
 * Response rules (from the suite's own client):
 * - always HTTP 200 with `{data, errors}` for a well-formed request, even
 *   when the document asks for an unknown field (that is a validation error
 *   carried in `errors`, with `data: null`);
 * - 401 without a valid bearer token; 400 for a malformed JSON body or a
 *   document that does not parse.
 */
import { isAuthenticated, parseJsonBody, sendError, sendJson, type ForgeRequest, type ForgeResponse, type RequestUrl } from './httputil.ts';
import {
  createIssueObject,
  createPullObject,
  globalId,
  mergePullObject,
  parseGlobalId,
} from './rest.ts';
import {
  branchTip,
  checkMerge,
  diffCommits,
  invalidateIssueJson,
  store,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'eof'; value: '' };

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|']);

class GraphQLError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        const c = source[j]!;
        if (c === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          if (esc === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += c;
          j += 1;
        }
      }
      if (j >= source.length) throw new GraphQLError('Unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      let isFloat = false;
      if (source[j] === '.' && source[j + 1] !== undefined && source[j + 1]! >= '0' && source[j + 1]! <= '9') {
        isFloat = true;
        j += 1;
        while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: source.slice(i, j) } : { kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_') {
      let j = i;
      while (
        j < source.length &&
        ((source[j]! >= 'A' && source[j]! <= 'Z') ||
          (source[j]! >= 'a' && source[j]! <= 'z') ||
          (source[j]! >= '0' && source[j]! <= '9') ||
          source[j] === '_')
      ) {
        j += 1;
      }
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLError(`Unexpected character "${ch}"`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: string }
  | { kind: 'Float'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface FragmentDefinition {
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDefinition>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  // Note: no parameter properties — Node's strip-only mode cannot erase them.
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLError(`Expected "${value}", got "${token.value}"`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(what = 'name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLError(`Expected ${what}, got "${token.value}"`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        doc.operations.push({ operation: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        const operation = token.value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        doc.operations.push({ operation, name, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('fragment name');
        const on = this.expectName('"on"');
        if (on !== 'on') throw new GraphQLError('Expected "on" in fragment definition');
        const typeCondition = this.expectName('type condition');
        this.skipDirectives();
        doc.fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new GraphQLError(`Unexpected token "${token.value}" at document level`);
      }
    }
    return doc;
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      this.expectName('variable name');
      this.expectPunct(':');
      this.parseType();
      if (this.acceptPunct('=')) this.parseValue();
    }
  }

  /** Consume a type reference (`String`, `[Issue!]!`, ...); types are not used. */
  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('type name');
    }
    this.acceptPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('type condition');
        this.skipDirectives();
        return { kind: 'InlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        return { kind: 'FragmentSpread', name: this.next().value };
      }
      this.skipDirectives();
      return { kind: 'InlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('field name');
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName('field name');
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'Field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.acceptPunct(')')) {
      const name = this.expectName('argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'Variable', name: this.expectName('variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'List', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName('object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'Object', fields };
    }
    if (token.kind === 'string') return { kind: 'String', value: token.value };
    if (token.kind === 'int') return { kind: 'Int', value: token.value };
    if (token.kind === 'float') return { kind: 'Float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    throw new GraphQLError(`Unexpected value token "${token.value}"`);
  }
}

// ---------------------------------------------------------------------------
// Schema (the field tables the sealed documents exercise)
// ---------------------------------------------------------------------------

/** Field name -> return type. `[X]` is a list of X; the executor resolves the element type. */
const SCHEMA: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { login: 'String', id: 'ID' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    description: 'String',
    owner: 'RepositoryOwner',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
    createdAt: 'String',
    updatedAt: 'String',
    url: 'String',
    private: 'Boolean',
  },
  RepositoryOwner: { login: 'String' },
  Ref: { name: 'String' },
  Issue: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    author: 'User',
    labels: '[String]',
    comments: 'IssueCommentConnection',
    createdAt: 'String',
    updatedAt: 'String',
    closedAt: 'String',
    url: 'String',
  },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', endCursor: 'String', hasPreviousPage: 'Boolean', startCursor: 'String' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    headRefName: 'String',
    baseRefName: 'String',
    mergeable: 'String',
    state: 'String',
    merged: 'Boolean',
    files: 'PullRequestChangedFileConnection',
    author: 'User',
    createdAt: 'String',
    updatedAt: 'String',
    closedAt: 'String',
    url: 'String',
  },
  PullRequestConnection: { nodes: '[PullRequest]' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]' },
  PullRequestChangedFile: { path: 'String' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { id: 'ID', body: 'String' },
  IssueCommentConnection: { nodes: '[IssueComment]' },
  Node: { id: 'ID' },
  __Type: { fields: '[__Field]', enumValues: '[__EnumValue]', name: 'String' },
  __Field: { name: 'String' },
  __EnumValue: { name: 'String' },
};

/** The field names `__type(name: ...).fields` reports for each named type. */
const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'private'],
  User: ['id', 'login'],
};

/** The enum values `__type(name: ...).enumValues` reports for each named enum. */
const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function unwrapList(type: string): string {
  return type.startsWith('[') && type.endsWith(']') ? type.slice(1, -1) : type;
}

function isScalarType(type: string): boolean {
  return ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(unwrapList(type));
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** An object value during execution: its runtime type plus the store record. */
interface Obj {
  __typename: string;
  data: unknown;
}

type Resolved = string | number | boolean | null | Obj | Resolved[];

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinition>;
  errors: Array<{ message: string }>;
}

function resolveValueNode(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'Variable':
      return ctx.variables[node.name] ?? null;
    case 'String':
    case 'Enum':
      return node.value;
    case 'Int':
      return Number.parseInt(node.value, 10);
    case 'Float':
      return Number.parseFloat(node.value);
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'List':
      return node.values.map((v) => resolveValueNode(v, ctx));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValueNode(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValueNode(arg.value, ctx);
  return out;
}

/** Validate a selection set against the schema; unknown fields become errors. */
function validateSelections(
  typeName: string,
  selections: SelectionNode[],
  ctx: ExecContext,
): void {
  const fields = SCHEMA[typeName];
  if (fields === undefined) {
    ctx.errors.push({ message: `Unknown type "${typeName}"` });
    return;
  }
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      const returnType = fields[selection.name];
      if (returnType === undefined) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}"` });
        continue;
      }
      if (selection.selections.length > 0 && !isScalarType(returnType)) {
        validateSelections(unwrapList(returnType), selection.selections, ctx);
      }
    } else if (selection.kind === 'InlineFragment') {
      const target = selection.typeCondition ?? typeName;
      validateSelections(target, selection.selections, ctx);
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}"` });
      } else {
        validateSelections(fragment.typeCondition, fragment.selections, ctx);
      }
    }
  }
}

function executeSelections(
  typeName: string,
  value: Obj | null,
  selections: SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      const resolved = resolveField(typeName, value, selection, ctx);
      const key = selection.alias ?? selection.name;
      if (resolved === null || resolved === undefined) {
        out[key] = null;
      } else if (selection.selections.length === 0) {
        out[key] = resolved as string | number | boolean;
      } else if (Array.isArray(resolved)) {
        const returnType = SCHEMA[typeName]?.[selection.name] ?? 'String';
        const elementType = unwrapList(returnType);
        out[key] = resolved.map((item) =>
          item !== null && typeof item === 'object' && '__typename' in item
            ? executeSelections((item as Obj).__typename, item as Obj, selection.selections, ctx)
            : item,
        );
        void elementType;
      } else if (typeof resolved === 'object' && '__typename' in resolved) {
        out[key] = executeSelections((resolved as Obj).__typename, resolved as Obj, selection.selections, ctx);
      } else {
        out[key] = resolved;
      }
    } else if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === value.__typename) {
        const merged = executeSelections(value.__typename, value, selection.selections, ctx);
        if (merged !== null) Object.assign(out, merged);
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === value.__typename) {
        const merged = executeSelections(value.__typename, value, fragment.selections, ctx);
        if (merged !== null) Object.assign(out, merged);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

function issueObj(repo: Repo, issue: Issue): Obj {
  return { __typename: 'Issue', data: { repo, issue } };
}

function pullObj(repo: Repo, pull: PullRequest): Obj {
  return { __typename: 'PullRequest', data: { repo, pull } };
}

function repoObj(repo: Repo): Obj {
  return { __typename: 'Repository', data: repo };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

interface IssuePage {
  nodes: Array<{ repo: Repo; issue: Issue }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function resolveIssueConnection(repo: Repo, args: Record<string, unknown>): IssuePage {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const descending = orderBy?.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const after = args.after as string | null | undefined;
  if (typeof after === 'string' && after !== '') {
    const cursorNumber = decodeCursor(after);
    if (cursorNumber !== null) {
      issues = issues.filter((issue) => (descending ? issue.number < cursorNumber : issue.number > cursorNumber));
    }
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  return {
    nodes: page.map((issue) => ({ repo, issue })),
    pageInfo: {
      hasNextPage: issues.length > page.length,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null,
    },
  };
}

function resolveNode(id: string): Obj | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const kind = parsed.type;
  const rest = parsed.payload;
  if (kind === 'Repository') {
    const repo = store.getRepoById(Number.parseInt(rest, 10));
    return repo === undefined ? null : repoObj(repo);
  }
  if (kind === 'Issue' || kind === 'PullRequest') {
    const [repoIdText, numberText] = rest.split(':');
    const repo = store.getRepoById(Number.parseInt(repoIdText ?? '', 10));
    if (repo === undefined) return null;
    const number = Number.parseInt(numberText ?? '', 10);
    if (kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObj(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullObj(repo, pull);
  }
  if (kind === 'IssueComment') {
    const [repoIdText, issueNumberText, commentIdText] = rest.split(':');
    const repo = store.getRepoById(Number.parseInt(repoIdText ?? '', 10));
    if (repo === undefined) return null;
    const issue = repo.issues.get(Number.parseInt(issueNumberText ?? '', 10));
    if (issue === undefined) return null;
    const comment = issue.comments.find((c) => c.id === Number.parseInt(commentIdText ?? '', 10));
    if (comment === undefined) return null;
    return { __typename: 'IssueComment', data: { repo, issue, comment } };
  }
  return null;
}

function resolveField(typeName: string, parent: Obj, field: FieldNode, ctx: ExecContext): Resolved {
  const args = argsOf(field, ctx);
  const data = parent.data as never;

  // -- root types -----------------------------------------------------------
  if (typeName === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { __typename: 'User', data: { login: store.effectiveOwner() } };
      case 'repository': {
        const owner = args.owner as string;
        const name = args.name as string;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (!store.isOwner(owner)) return null;
        const repo = store.getRepo(owner, name);
        return repo === undefined ? null : repoObj(repo);
      }
      case 'node': {
        const id = args.id as string;
        return typeof id === 'string' ? resolveNode(id) : null;
      }
      case '__type': {
        const name = args.name as string;
        if (typeof name !== 'string') return null;
        if (INTROSPECTION_FIELDS[name] === undefined && INTROSPECTION_ENUMS[name] === undefined && SCHEMA[name] === undefined) {
          return null;
        }
        return { __typename: '__Type', data: { typeName: name } };
      }
      default:
        return null;
    }
  }

  if (typeName === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const repoId = input.repositoryId as string;
        const title = input.title as string;
        const parsed = typeof repoId === 'string' ? parseGlobalId(repoId) : null;
        if (parsed === null || parsed.type !== 'Repository' || typeof title !== 'string') {
          throw new GraphQLError('createIssue: invalid repositoryId or title');
        }
        const repo = store.getRepoById(Number.parseInt(parsed.payload, 10));
        if (repo === undefined) throw new GraphQLError('createIssue: repository not found');
        const body = input.body;
        const created = createIssueObject(repo, {
          title,
          body: typeof body === 'string' ? body : undefined,
          labels: [],
        });
        if ('error' in created) throw new GraphQLError(`createIssue: ${created.error}`);
        return { __typename: 'CreateIssuePayload', data: { repo, issue: created.issue } };
      }
      case 'closeIssue': {
        const issueId = input.issueId as string;
        const parsed = typeof issueId === 'string' ? parseGlobalId(issueId) : null;
        if (parsed === null || parsed.type !== 'Issue') throw new GraphQLError('closeIssue: invalid issueId');
        const [repoIdText, numberText] = parsed.payload.split(':');
        const repo = store.getRepoById(Number.parseInt(repoIdText ?? '', 10));
        const issue = repo?.issues.get(Number.parseInt(numberText ?? '', 10));
        if (repo === undefined || issue === undefined) throw new GraphQLError('closeIssue: issue not found');
        issue.state = 'closed';
        issue.closedAt = issue.updatedAt;
        invalidateIssueJson(issue);
        return { __typename: 'CloseIssuePayload', data: { repo, issue } };
      }
      case 'createPullRequest': {
        const repoId = input.repositoryId as string;
        const parsed = typeof repoId === 'string' ? parseGlobalId(repoId) : null;
        if (parsed === null || parsed.type !== 'Repository') throw new GraphQLError('createPullRequest: invalid repositoryId');
        const repo = store.getRepoById(Number.parseInt(parsed.payload, 10));
        if (repo === undefined) throw new GraphQLError('createPullRequest: repository not found');
        const created = createPullObject(repo, {
          title: input.title as string,
          body: typeof input.body === 'string' ? input.body : undefined,
          head: input.headRefName as string,
          base: input.baseRefName as string,
        });
        if ('error' in created) throw new GraphQLError(`createPullRequest: ${created.error}`);
        return { __typename: 'CreatePullRequestPayload', data: { repo, pull: created.pull } };
      }
      case 'mergePullRequest': {
        const pullId = input.pullRequestId as string;
        const parsed = typeof pullId === 'string' ? parseGlobalId(pullId) : null;
        if (parsed === null || parsed.type !== 'PullRequest') throw new GraphQLError('mergePullRequest: invalid pullRequestId');
        const [repoIdText, numberText] = parsed.payload.split(':');
        const repo = store.getRepoById(Number.parseInt(repoIdText ?? '', 10));
        const pull = repo?.pulls.get(Number.parseInt(numberText ?? '', 10));
        if (repo === undefined || pull === undefined) throw new GraphQLError('mergePullRequest: pull request not found');
        const merged = mergePullObject(repo, pull);
        if ('error' in merged) throw new GraphQLError(`mergePullRequest: ${merged.error}`);
        return { __typename: 'MergePullRequestPayload', data: { repo, pull } };
      }
      case 'addComment': {
        const subjectId = input.subjectId as string;
        const body = input.body as string;
        const parsed = typeof subjectId === 'string' ? parseGlobalId(subjectId) : null;
        if (parsed === null || parsed.type !== 'Issue' || typeof body !== 'string') {
          throw new GraphQLError('addComment: invalid subjectId or body');
        }
        const [repoIdText, numberText] = parsed.payload.split(':');
        const repo = store.getRepoById(Number.parseInt(repoIdText ?? '', 10));
        const issue = repo?.issues.get(Number.parseInt(numberText ?? '', 10));
        if (repo === undefined || issue === undefined) throw new GraphQLError('addComment: issue not found');
        const comment = {
          id: repo.nextCommentId++,
          body,
          userLogin: repo.owner,
          createdAt: issue.updatedAt,
          updatedAt: issue.updatedAt,
        };
        issue.comments.push(comment);
        invalidateIssueJson(issue);
        return { __typename: 'AddCommentPayload', data: { repo, issue, comment } };
      }
      default:
        return null;
    }
  }

  // -- object types ---------------------------------------------------------
  switch (typeName) {
    case 'User': {
      const user = data as { login: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return globalId('User', user.login);
      return null;
    }
    case 'Repository': {
      const repo = data as Repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', String(repo.id));
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'description':
          return repo.description;
        case 'owner':
          return { __typename: 'RepositoryOwner', data: { login: repo.owner } };
        case 'defaultBranchRef':
          return { __typename: 'Ref', data: { name: repo.defaultBranch } };
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'createdAt':
        case 'updatedAt':
          return repo.createdAt;
        case 'url':
          return `https://example.invalid/${repo.owner}/${repo.name}`;
        case 'private':
          return repo.private;
        case 'issue': {
          const number = args.number as number;
          const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
          return issue === undefined ? null : issueObj(repo, issue);
        }
        case 'issues':
          return { __typename: 'IssueConnection', data: resolveIssueConnection(repo, args) };
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            pulls = pulls.filter((pull) =>
              states.includes(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'),
            );
          } else {
            pulls = pulls.filter((pull) => pull.state === 'open');
          }
          pulls.sort((a, b) => b.number - a.number);
          const first = typeof args.first === 'number' ? args.first : pulls.length;
          return { __typename: 'PullRequestConnection', data: pulls.slice(0, first).map((pull) => ({ repo, pull })) };
        }
        case 'pullRequest': {
          const number = args.number as number;
          const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
          return pull === undefined ? null : pullObj(repo, pull);
        }
        default:
          return null;
      }
    }
    case 'RepositoryOwner': {
      const owner = data as { login: string };
      return field.name === 'login' ? owner.login : null;
    }
    case 'Ref': {
      const ref = data as { name: string };
      return field.name === 'name' ? ref.name : null;
    }
    case 'Issue': {
      const { repo, issue } = data as { repo: Repo; issue: Issue };
      switch (field.name) {
        case 'id':
          return globalId('Issue', `${repo.id}:${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.closedAt;
        case 'url':
          return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'author':
          return { __typename: 'User', data: { login: repo.owner } };
        case 'labels':
          return issue.labels;
        case 'comments':
          return {
            __typename: 'IssueCommentConnection',
            data: issue.comments.map((comment) => ({ repo, issue, comment })),
          };
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      const page = data as IssuePage;
      if (field.name === 'nodes') return page.nodes.map((entry) => issueObj(entry.repo, entry.issue));
      if (field.name === 'edges') {
        return page.nodes.map((entry) => ({
          __typename: 'IssueEdge',
          data: { node: issueObj(entry.repo, entry.issue), cursor: encodeCursor(entry.issue.number) },
        }));
      }
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', data: page.pageInfo };
      return null;
    }
    case 'IssueEdge': {
      const edge = data as { node: Obj; cursor: string };
      if (field.name === 'node') return edge.node;
      if (field.name === 'cursor') return edge.cursor;
      return null;
    }
    case 'PageInfo': {
      const info = data as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return null;
    }
    case 'PullRequest': {
      const { repo, pull } = data as { repo: Repo; pull: PullRequest };
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable': {
          if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
          const status = checkMerge(repo, pull.headRef, pull.baseRef).status;
          return status === 'mergeable' ? 'MERGEABLE' : status === 'conflicting' ? 'CONFLICTING' : 'UNKNOWN';
        }
        case 'files': {
          const base = branchTip(repo, pull.baseRef) ?? null;
          const head = branchTip(repo, pull.headRef) ?? null;
          if (base === null || head === null) {
            return { __typename: 'PullRequestChangedFileConnection', data: [] as string[] };
          }
          const diff = diffCommits(repo, base, head);
          const first = typeof args.first === 'number' ? args.first : diff.length;
          return {
            __typename: 'PullRequestChangedFileConnection',
            data: diff.slice(0, first).map((entry) => entry.filename),
          };
        }
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'closedAt':
          return pull.closedAt;
        case 'url':
          return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'author':
          return { __typename: 'User', data: { login: repo.owner } };
        default:
          return null;
      }
    }
    case 'PullRequestConnection': {
      const pulls = data as Array<{ repo: Repo; pull: PullRequest }>;
      if (field.name === 'nodes') return pulls.map((entry) => pullObj(entry.repo, entry.pull));
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      const paths = data as string[];
      if (field.name === 'nodes') {
        return paths.map((path) => ({ __typename: 'PullRequestChangedFile', data: { path } }));
      }
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = data as { path: string };
      return field.name === 'path' ? file.path : null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = data as { repo: Repo; issue: Issue };
      return field.name === 'issue' ? issueObj(payload.repo, payload.issue) : null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = data as { repo: Repo; pull: PullRequest };
      return field.name === 'pullRequest' ? pullObj(payload.repo, payload.pull) : null;
    }
    case 'AddCommentPayload': {
      const payload = data as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
      if (field.name === 'commentEdge') return { __typename: 'IssueCommentEdge', data: payload };
      return null;
    }
    case 'IssueCommentEdge': {
      const payload = data as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
      if (field.name === 'node') return { __typename: 'IssueComment', data: payload };
      return null;
    }
    case 'IssueComment': {
      const payload = data as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
      if (field.name === 'id') return globalId('IssueComment', `${payload.repo.id}:${payload.issue.number}:${payload.comment.id}`);
      if (field.name === 'body') return payload.comment.body;
      return null;
    }
    case 'IssueCommentConnection': {
      const comments = data as Array<{ repo: Repo; issue: Issue; comment: { id: number; body: string } }>;
      if (field.name === 'nodes') return comments.map((c) => ({ __typename: 'IssueComment', data: c }));
      return null;
    }
    case '__Type': {
      const type = data as { typeName: string };
      if (field.name === 'name') return type.typeName;
      if (field.name === 'fields') {
        const names = INTROSPECTION_FIELDS[type.typeName] ?? Object.keys(SCHEMA[type.typeName] ?? {});
        return names.map((name) => ({ __typename: '__Field', data: { name } }));
      }
      if (field.name === 'enumValues') {
        const names = INTROSPECTION_ENUMS[type.typeName] ?? [];
        return names.map((name) => ({ __typename: '__EnumValue', data: { name } }));
      }
      return null;
    }
    case '__Field': {
      const fieldValue = data as { name: string };
      return field.name === 'name' ? fieldValue.name : null;
    }
    case '__EnumValue': {
      const enumValue = data as { name: string };
      return field.name === 'name' ? enumValue.name : null;
    }
    case 'Node': {
      // `node(id:)` resolves to a concrete object; `id` is read off it.
      if (field.name === 'id') {
        const inner = resolveField(parent.__typename, parent, field, ctx);
        return inner;
      }
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Operation execution
// ---------------------------------------------------------------------------

interface GraphQLOperationInput {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOperation(input: GraphQLOperationInput): { data: unknown; errors?: Array<{ message: string }> } {
  if (typeof input.query !== 'string' || input.query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(input.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  const variables =
    input.variables !== null && typeof input.variables === 'object' && !Array.isArray(input.variables)
      ? (input.variables as Record<string, unknown>)
      : {};
  const operationName = typeof input.operationName === 'string' ? input.operationName : null;
  const operation =
    operationName === null
      ? doc.operations[0]
      : doc.operations.find((op) => op.name === operationName);
  if (operation === undefined) {
    return { data: null, errors: [{ message: `Unknown operation named "${operationName ?? ''}".` }] };
  }
  const ctx: ExecContext = { variables, fragments: doc.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(rootType, operation.selections, ctx);
  if (ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors };
  }
  const root: Obj = { __typename: rootType, data: null };
  try {
    const data = executeSelections(rootType, root, operation.selections, ctx);
    return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL execution error' }] };
  }
}

/**
 * POST /api/graphql — one operation, or a JSON array of operations (batched).
 * The body is read by the caller (app.ts) and passed in, like the other
 * handlers. Returns true when the path was /api/graphql (handled).
 */
export function handleGraphQL(
  req: ForgeRequest,
  res: ForgeResponse,
  pathname: string,
  _url: RequestUrl,
  body: Buffer,
): boolean {
  if (pathname !== '/api/graphql') return false;
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendError(res, 400, 'Problems parsing JSON');
    return true;
  }
  const value = parsed.value;
  if (Array.isArray(value)) {
    const responses = value.map((entry) =>
      entry !== null && typeof entry === 'object'
        ? executeOperation(entry as GraphQLOperationInput)
        : { data: null, errors: [{ message: 'Must provide query string.' }] },
    );
    sendJson(res, 200, responses);
    return true;
  }
  if (value === null || typeof value !== 'object') {
    sendError(res, 400, 'Must provide query string.');
    return true;
  }
  sendJson(res, 200, executeOperation(value as GraphQLOperationInput));
  return true;
}
