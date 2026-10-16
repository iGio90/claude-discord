// Splits an outbound Discord message into chunks under the length cap.
// 'newline' prefers paragraph, then line, then word boundaries; 'length' cuts at the cap.
// Neither mode cuts inside a mention (<@id>, <@&id>, <#id>), and a code fence
// left open by a chunk is closed there and reopened in the next one.
export type ChunkMode = 'length' | 'newline'

const FENCE = '```'

export function chunk(text: string, limit: number, mode: ChunkMode): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  let openFence: string | null = null
  while (rest.length > 0) {
    // A chunk that continues an open fence starts by reopening it.
    const prefix = openFence ?? ''
    const room = limit - prefix.length - (openFence ? FENCE.length + 1 : 0)
    if (rest.length + prefix.length <= limit) {
      out.push(prefix + rest)
      break
    }
    let cut = room
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', room)
      const line = rest.lastIndexOf('\n', room)
      const space = rest.lastIndexOf(' ', room)
      cut = para > room / 2 ? para : line > room / 2 ? line : space > 0 ? space : room
    }
    cut = outsideMention(rest, cut)
    let piece = rest.slice(0, cut)
    rest = rest.slice(cut).replace(/^\n+/, '')
    const fence = fenceLeftOpen(prefix + piece)
    if (fence !== null) {
      piece = piece.replace(/\n?$/, '\n') + FENCE
      openFence = fence + '\n'
    } else {
      openFence = null
    }
    out.push(prefix + piece)
  }
  return out
}

// Moves a cut that falls inside <@id>, <@&id> or <#id> back to the mention's start.
function outsideMention(s: string, cut: number): number {
  const open = s.lastIndexOf('<', cut - 1)
  if (open < 0) return cut
  const close = s.indexOf('>', open)
  if (close < 0 || close < cut) return cut
  if (/^<(@[!&]?|#)\d+$/.test(s.slice(open, cut))) return open > 0 ? open : cut
  return cut
}

// The opening line of a code fence the text leaves unclosed, else null.
function fenceLeftOpen(s: string): string | null {
  let open: string | null = null
  for (const line of s.split('\n')) {
    const t = line.trimStart()
    if (!t.startsWith(FENCE)) continue
    open = open === null ? t : null
  }
  return open
}
