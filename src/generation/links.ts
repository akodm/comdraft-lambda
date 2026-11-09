import { Readability } from '@mozilla/readability';
import dns from 'node:dns';
import { BlockList, type LookupFunction, isIP } from 'node:net';
import { parseHTML } from 'linkedom';
import { Agent, fetch as undiciFetch } from 'undici';

import {
  LINK_MAX_BYTES,
  LINK_MAX_REDIRECTS,
  LINK_TIMEOUT_MS,
  LINK_TITLE_MAX,
  LINK_TOKEN_BUDGET,
  MAX_REFERENCE_LINKS,
  estimateTokens,
} from './limits.ts';

export interface PreparedLink {
  id: string;
  url: string;
  title: string;
  text: string;
}

export type LinkFetch = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal },
) => Promise<Response>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPTED_TYPES = new Set(['text/html', 'text/plain', 'text/markdown']);

// 연결을 막을 주소 범위 (스펙 5절)
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

// IPv4-mapped IPv6(::ffff:a.b.c.d) 를 IPv4 문자열로 바꾼다. 아니면 null
const unmapIPv4 = (address: string): string | null => {
  let normalized: string;
  try {
    normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (!match) return null;
  const hi = parseInt(match[1], 16);
  const lo = parseInt(match[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
};

export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const mapped = unmapIPv4(address);
    if (mapped) return !blocked.check(mapped, 'ipv4');
    return !blocked.check(address, 'ipv6');
  }
  return !blocked.check(address, 'ipv4');
};

// http/https, 기본 포트, 자격 증명 없음, IP 리터럴이면 공인 주소만
export const isAllowedUrl = (url: URL): boolean => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port !== '') return false; // URL 은 기본 포트를 빈 문자열로 정규화한다
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(host) !== 0) return isPublicAddress(host);
  return true;
};

// DNS 결과를 검사한 뒤 그 주소로 그대로 연결하게 한다 (rebinding 방지)
export const createSafeLookup = (resolve: typeof dns.lookup = dns.lookup): LookupFunction => {
  return ((hostname, options, callback) => {
    const wantAll = typeof options === 'object' && options !== null && options.all === true;
    const base = typeof options === 'object' && options !== null ? options : {};
    resolve(hostname, { ...base, all: true }, (err, addresses) => {
      const list = (addresses ?? []) as unknown as dns.LookupAddress[];
      if (err) return callback(err, '', 4);
      if (list.length === 0 || !list.every((a) => isPublicAddress(a.address))) {
        return callback(new Error('blocked address'), '', 4);
      }
      if (wantAll) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }) as LookupFunction;
};

export const createLinkFetch = (): LinkFetch => {
  const dispatcher = new Agent({ connect: { lookup: createSafeLookup() } });
  return (url, init) =>
    undiciFetch(url, { ...init, dispatcher }) as unknown as Promise<Response>;
};

const collapse = (text: string): string =>
  text
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const extractReadableText = (html: string, url: string): { title: string; text: string } => {
  const { document } = parseHTML(html);
  const docTitle = document.title ?? '';
  let title = '';
  let text = '';
  try {
    const base = document.createElement('base');
    base.setAttribute('href', url);
    document.head?.append(base);
    const article = new Readability(document as never).parse();
    title = article?.title ?? '';
    text = article?.textContent ?? '';
  } catch {
    // readability 실패 시 아래에서 body 텍스트로 대체
  }
  if (!collapse(text)) text = document.body?.textContent ?? '';
  return { title: (title || docTitle).replace(/\s+/g, ' ').trim(), text: collapse(text) };
};

// 토큰 상한을 넘으면 글자 수를 이분 탐색으로 줄인다
const truncateToBudget = (text: string, budget: number): string => {
  if (estimateTokens(text) <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  let cut = text.slice(0, lo);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
};

// 본문을 LINK_MAX_BYTES 까지만 읽고 나머지는 취소한다
const readBody = async (response: Response): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < LINK_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(total, LINK_MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder('utf-8').decode(bytes);
};

const fetchFollowingRedirects = async (
  start: URL,
  fetchImpl: LinkFetch,
  signal: AbortSignal,
): Promise<Response | null> => {
  let current = start;
  for (let hops = 0; hops <= LINK_MAX_REDIRECTS; hops += 1) {
    if (!isAllowedUrl(current)) return null;
    const response = await fetchImpl(current.href, { redirect: 'manual', signal });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location) return null;
    current = new URL(location, current);
  }
  return null;
};

const fetchOne = async (rawUrl: string, fetchImpl: LinkFetch): Promise<Omit<PreparedLink, 'id'> | null> => {
  const url = new URL(rawUrl);
  const signal = AbortSignal.timeout(LINK_TIMEOUT_MS);
  const response = await fetchFollowingRedirects(url, fetchImpl, signal);
  if (!response || response.status < 200 || response.status >= 300) {
    await response?.body?.cancel().catch(() => undefined);
    return null;
  }
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!ACCEPTED_TYPES.has(type)) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = await readBody(response);
  const extracted =
    type === 'text/html' ? extractReadableText(body, url.href) : { title: '', text: collapse(body) };
  const text = truncateToBudget(extracted.text, LINK_TOKEN_BUDGET);
  if (!text) return null;
  const title = extracted.title.slice(0, LINK_TITLE_MAX).trim() || url.hostname;
  return { url: rawUrl, title, text };
};

export const fetchReferenceLinks = async (urls: string[], fetchImpl: LinkFetch): Promise<PreparedLink[]> => {
  const settled = await Promise.allSettled(
    urls.slice(0, MAX_REFERENCE_LINKS).map((u) => fetchOne(u, fetchImpl)),
  );
  const links: PreparedLink[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) {
      links.push({ id: `L${links.length + 1}`, ...result.value });
    }
  }
  return links;
};
