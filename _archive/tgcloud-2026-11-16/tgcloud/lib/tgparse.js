// Разбор публичной страницы канала t.me/s/<name> (FR-07). Чистая функция:
// сеть — в tgweb.js, чтобы парсер гонялся в node --test без платформы.

import { decodeEntities, isoFromMs, isoNow, stripTags } from './text.js';

const POST_SPLIT = /data-post="/g;

/**
 * @param {string} html ответ t.me/s/<name> (или его ?before=-страницы)
 * @param {string} channel username без @
 * @returns {{items:{title:string,url:string,published:string,text:string,postId:number}[], minId:number|null, maxId:number|null}}
 */
export function parseChannelPage(html, channel) {
  const source = String(html ?? '');
  const pieces = source.split(POST_SPLIT).slice(1);
  const items = [];
  for (const piece of pieces) {
    const idMatch = piece.match(/^([^"]+)"[\s\S]*?$/);
    if (!idMatch) continue;
    const dataPost = idMatch[1];
    const slash = dataPost.lastIndexOf('/');
    const postId = Number(dataPost.slice(slash + 1));
    if (!Number.isFinite(postId) || postId <= 0) continue;

    const textMatch = piece.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const body = textMatch ? stripTags(textMatch[1]) : '';
    const timeMatch = piece.match(/<time[^>]*datetime="([^"]+)"/i);
    const ms = timeMatch ? Date.parse(timeMatch[1]) : NaN;
    const published = Number.isFinite(ms) ? isoFromMs(ms) : isoNow();

    // Заголовка у поста нет: берём первый абзац (до 120 символов) как заголовок,
    // весь текст — в items.text. Пустой пост (только картинка) не пропускаем:
    // ссылка на пост и дата полезны для сводки.
    const firstLine = body.split(/\s*(?:\n|\.\s)/)[0]?.trim() ?? '';
    const title = (firstLine || `Пост ${channel}/${postId}`).slice(0, 120);
    items.push({
      postId,
      title,
      url: `https://t.me/${channel}/${postId}`,
      published,
      text: body.slice(0, 8000),
    });
  }
  items.sort((a, b) => b.postId - a.postId);
  const ids = items.map((i) => i.postId);
  return {
    items,
    minId: ids.length ? Math.min(...ids) : null,
    maxId: ids.length ? Math.max(...ids) : null,
  };
}

/** Номер поста из ссылки на канал/пост (для CRUD источников, D48). */
export function channelFromInput(text) {
  const value = String(text ?? '').trim();
  const direct = value.match(/^(?:@|t\.me\/s\/|t\.me\/|telegram\.me\/)?([a-z0-9_]{4,32})$/i);
  if (direct) return direct[1].toLowerCase();
  const post = value.match(/t\.me\/([a-z0-9_]{4,32})\/\d+/i);
  return post ? post[1].toLowerCase() : null;
}

export { decodeEntities };
