// Оркестрация LLM-части сводки: один вызов или веер из двух частей + общий
// лид/синтез. Вынесено из handlers/message.js, чтобы ветки ошибок и обрезки
// гонялись в node --test с подменённым summarize (без sdk и сети).

import { formatItemsInput, joinDigestParts, mergeSections, splitEditor, splitIntoParts } from './digest.js';
import { LlmTruncatedError } from './llm-core.js';
import { FANOUT_EDITOR_PREFIX, FANOUT_SECTIONS_PREFIX } from './prompts.js';

/** Одна сводка: обычный вызов или веер, если пунктов достаточно. */
export async function summarizeDigest({ selected, interestsText, config, budget, caps, left, summarize }) {
  if (budget.fanout?.enabled && selected.length >= budget.fanout.minItems) {
    return summarizeFanout({ selected, interestsText, config, budget, summarize });
  }
  return summarizeSingle({ selected, interestsText, config, budget, caps, left, summarize });
}

/** Один вызов с восстановлением после обрезки по max_tokens. */
export async function summarizeSingle({ selected, interestsText, config, budget, caps, left, summarize }) {
  const call = (rows) => summarize(formatItemsInput(rows, config.digest.textCap), interestsText, null, {
    thinking: budget.thinking,
    maxTokens: caps.maxTokens,
    attempts: 1,
  });
  try {
    return { text: await call(selected), items: selected };
  } catch (error) {
    const partial = String(error?.partial ?? '').trim();
    console.log(`LLM обрезала ответ: частичный текст ${partial.length} симв.`);
    // Обрезанный текст лучше ошибки: он полон по смыслу, просто короче.
    if (error instanceof LlmTruncatedError && partial.length > 400) {
      return { text: partial, items: selected, note: '⚠️ Сводка сокращена: ответ не влез в лимит вызова.' };
    }
    if (!(error instanceof LlmTruncatedError) || left() < 12000 || selected.length < 6) throw error;
    const half = selected.slice(0, Math.max(5, Math.floor(selected.length / 2)));
    console.log(`LLM обрезала ответ, повтор с ${half.length} пунктами`);
    return { text: await call(half), items: half, note: '⚠️ Сводка сокращена: повтор с половиной пунктов.' };
  }
}

/** Веер: две части пишут только разделы, третья параллельно — общий лид,
 * синтез и радар. Ждём самую медленную часть, а не сумму. Упавшая часть
 * не отменяет сводку; в прочитанное попадает только то, что дошло до текста. */
export async function summarizeFanout({ selected, interestsText, config, budget, summarize }) {
  const parts = splitIntoParts(selected, budget.fanout.parts);
  const editorIndex = parts.length;
  const run = async (rows, prefix, maxTokens, index) => {
    try {
      const text = await summarize(`${prefix}${formatItemsInput(rows, config.digest.textCap)}`, interestsText, null, {
        thinking: budget.thinking,
        maxTokens,
        attempts: 1,
      });
      return { index, rows, text };
    } catch (error) {
      const partial = String(error?.partial ?? '').trim();
      console.error(`веер, часть ${index + 1}:`, error?.message ?? error);
      if (error instanceof LlmTruncatedError && partial.length > 400) return { index, rows, text: partial, truncated: true };
      return { index, rows, error };
    }
  };
  const results = await Promise.all([
    ...parts.map((rows, index) => run(rows, FANOUT_SECTIONS_PREFIX, budget.fanout.maxTokensPerPart, index)),
    run(selected, FANOUT_EDITOR_PREFIX, budget.fanout.maxTokensEditor ?? 2500, editorIndex),
  ]);
  const maps = results.filter((result) => result.index !== editorIndex);
  const editor = results.find((result) => result.index === editorIndex);
  const okMaps = maps.filter((result) => result.text?.trim());
  if (!okMaps.length) throw maps.find((result) => result.error)?.error ?? editor?.error ?? new Error('ни одна часть сводки не собралась');
  const notes = [];
  if (okMaps.some((result) => result.truncated)) notes.push('часть сводки сокращена по лимиту');
  if (editor?.truncated) notes.push('общий лид/синтез сокращён по лимиту');
  const failedMaps = maps.filter((result) => result.error);
  if (failedMaps.length) notes.push(`часть ${failedMaps.map((result) => result.index + 1).join(', ')} не собралась`);
  const editorText = editor?.text?.trim() ? editor.text.trim() : '';
  if (!editorText) notes.push('общий лид/синтез не собрался');
  const { lead, tail } = splitEditor(editorText);
  const sections = mergeSections(joinDigestParts(okMaps.map((result) => ({ index: result.index, text: result.text }))));
  const text = [lead, sections, tail].filter(Boolean).join('\n\n');
  return {
    text,
    items: okMaps.flatMap((result) => result.rows),
    note: notes.length ? `⚠️ ${notes.join('; ')}.` : '',
  };
}
