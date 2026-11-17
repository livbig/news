// Стартовый набор источников под профиль интересов (DEFAULT_INTERESTS).
// Задача — не «все новости мира», а плотный поток по темам: Россия и мир, металлы/валюты,
// рынок США, AI-модели и роботы, IPO/биотех, макро/ЦБ, геополитика направлением, крипта кратко.
// Список проверен с Pi (2026-11-11): 200 + разбираемый фид. Термины интересов дают ещё
// по одному Google News RSS на тему (store.addInterestSources).

import { DEFAULT_INTERESTS, LEGACY_PROFILES } from './prompts.js';
import { googleNewsUrl, normalizeTerm } from './interests.js';
import { addInterestSources, addSource, ensureUser, getInterests, listSources, setInterests } from './store.js';

/** kind: rss | tgweb | html. Проверено с Pi: адрес отвечает и отдаёт пункты. */
export const DEFAULT_PACK = [
  // Россия и деньги (ближе всего к читателю)
  { kind: 'rss', url: 'https://www.vedomosti.ru/rss/news.xml', title: 'Ведомости', topics: ['макро', 'рынок'] },
  { kind: 'rss', url: 'https://www.kommersant.ru/RSS/news.xml', title: 'Коммерсантъ', topics: ['макро', 'геополитика'] },
  { kind: 'rss', url: 'https://tass.ru/rss/v2.xml', title: 'ТАСС', topics: ['геополитика', 'макро'] },
  { kind: 'rss', url: 'https://www.interfax.ru/rss.asp', title: 'Интерфакс', topics: ['макро', 'геополитика'] },
  { kind: 'rss', url: 'https://1prime.ru/export/rss2/archive/index.xml', title: '1Prime', topics: ['макро', 'валюты'] },
  { kind: 'rss', url: 'https://www.finam.ru/analysis/conews/rsspoint/', title: 'Финам — новости', topics: ['рынок США', 'инвест-идеи'] },
  { kind: 'rss', url: 'https://ru.investing.com/rss/news_25.rss', title: 'Investing.com (RU)', topics: ['рынок США', 'макро'] },

  // Центробанки и регулирование
  { kind: 'rss', url: 'https://www.cbr.ru/rss/RssNews', title: 'Банк России — новости', topics: ['макро'] },
  { kind: 'rss', url: 'https://www.cbr.ru/rss/RssPress', title: 'Банк России — пресс-релизы', topics: ['макро', 'регулирование'] },
  { kind: 'rss', url: 'https://www.federalreserve.gov/feeds/press_all.xml', title: 'ФРС — пресс-релизы', topics: ['макро'] },
  { kind: 'rss', url: 'https://www.sec.gov/news/pressreleases.rss', title: 'SEC — пресс-релизы', topics: ['макро', 'регулирование'] },

  // Металлы и валюты
  { kind: 'rss', url: 'https://www.investing.com/rss/commodities.rss', title: 'Investing — Commodities', topics: ['драгметаллы', 'сырьё'] },
  { kind: 'rss', url: 'https://www.fxstreet.com/rss/news', title: 'FXStreet', topics: ['валюты'] },
  { kind: 'rss', url: 'https://www.forexlive.com/feed/news', title: 'ForexLive', topics: ['валюты', 'макро'] },

  // Рынок США и инвест-идеи
  { kind: 'rss', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258', title: 'CNBC — Markets', topics: ['рынок США'] },
  { kind: 'rss', url: 'https://www.marketwatch.com/rss/topstories', title: 'MarketWatch — Top Stories', topics: ['рынок США'] },
  { kind: 'rss', url: 'https://seekingalpha.com/market_currents.xml', title: 'Seeking Alpha — Market Currents', topics: ['рынок США', 'инвест-идеи'] },
  { kind: 'rss', url: 'https://www.reddit.com/r/wallstreetbets/.rss', title: 'r/wallstreetbets', topics: ['инвест-идеи'] },

  // AI, технологии, роботы
  { kind: 'rss', url: 'https://techcrunch.com/feed/', title: 'TechCrunch', topics: ['AI-модели'] },
  { kind: 'rss', url: 'https://www.theverge.com/rss/index.xml', title: 'The Verge', topics: ['AI-модели'] },
  { kind: 'rss', url: 'https://arstechnica.com/feed/', title: 'Ars Technica', topics: ['AI-модели'] },
  { kind: 'rss', url: 'https://blog.google/technology/ai/rss/', title: 'Google — AI Blog', topics: ['AI-модели'] },
  { kind: 'rss', url: 'https://www.therobotreport.com/feed/', title: 'The Robot Report', topics: ['робототехника'] },
  // Physical AI / робототехника: плотность держат Google News EN и HN с фильтром по словам —
  // у IEEE, Robohub и тега TechCrunch Robotics выходит 1–2 материала в неделю.
  { kind: 'rss', url: 'https://spectrum.ieee.org/feeds/topic/robotics.rss', title: 'IEEE Spectrum — Robotics', topics: ['робототехника', 'Physical AI'] },
  { kind: 'rss', url: 'https://robohub.org/feed/', title: 'Robohub', topics: ['робототехника', 'Physical AI'] },
  { kind: 'rss', url: 'https://techcrunch.com/tag/robotics/feed/', title: 'TechCrunch — Robotics', topics: ['робототехника'] },
  { kind: 'rss', url: 'https://hnrss.org/newest?q=robotics+OR+%22physical+AI%22+OR+humanoid&points=40', title: 'Hacker News — робототехника/Physical AI (40+)', topics: ['робототехника', 'Physical AI'] },
  { kind: 'rss', url: 'https://news.google.com/rss/search?q=%22physical+AI%22+OR+%22embodied+AI%22&hl=en-US&gl=US&ceid=US:en', title: 'Google News (EN): Physical AI / Embodied AI', topics: ['Physical AI'] },
  { kind: 'rss', url: 'https://news.google.com/rss/search?q=humanoid+robot&hl=en-US&gl=US&ceid=US:en', title: 'Google News (EN): Humanoid robots', topics: ['робототехника'] },
  { kind: 'rss', url: 'https://news.google.com/rss/search?q=robotics+funding+OR+%22robotics+startup%22&hl=en-US&gl=US&ceid=US:en', title: 'Google News (EN): робототехника — раунды и стартапы', topics: ['робототехника', 'IPO', 'инвест-идеи'] },
  { kind: 'rss', url: 'https://hnrss.org/newest?points=300', title: 'Hacker News (300+)', topics: ['AI-модели', 'промпт-инжиниринг'] },
  { kind: 'rss', url: 'https://habr.com/ru/rss/news/', title: 'Хабр — новости', topics: ['AI-модели', 'технологии'] },
  { kind: 'rss', url: 'https://nplus1.ru/rss', title: 'N+1', topics: ['наука', 'AI-модели'] },
  { kind: 'rss', url: 'https://www.ixbt.com/export/news.rss', title: 'iXBT', topics: ['технологии'] },
  { kind: 'rss', url: 'https://vc.ru/rss', title: 'vc.ru', topics: ['технологии', 'AI-модели'] },

  // IPO и биотех
  { kind: 'rss', url: 'https://news.crunchbase.com/feed/', title: 'Crunchbase News', topics: ['IPO'] },
  { kind: 'rss', url: 'https://www.fiercebiotech.com/rss.xml', title: 'Fierce Biotech', topics: ['биотех'] },

  // Геополитика (направление, не хроника)
  { kind: 'rss', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', title: 'BBC World', topics: ['геополитика'] },
  { kind: 'rss', url: 'https://www.france24.com/en/rss', title: 'France 24', topics: ['геополитика'] },
  { kind: 'rss', url: 'https://www.aljazeera.com/xml/rss/all.xml', title: 'Al Jazeera', topics: ['геополитика'] },

  // Крипта (кратко)
  { kind: 'rss', url: 'https://cointelegraph.com/rss', title: 'Cointelegraph', topics: ['крипта'] },
  { kind: 'rss', url: 'https://decrypt.co/feed', title: 'Decrypt', topics: ['крипта'] },
  { kind: 'rss', url: 'https://forklog.com/feed/', title: 'ForkLog', topics: ['крипта'] },

  // Telegram-каналы (через зеркало; прямой t.me с Pi отдаёт пустую страницу)
  { kind: 'tgweb', url: '@rbc_news', title: 'РБК (Telegram)', topics: ['макро', 'геополитика'] },
  { kind: 'tgweb', url: '@ai_newz', title: 'AI Newz (Telegram)', topics: ['AI-модели'] },
];

/** Адреса, которые с Pi стабильно не работают (404/таймаут) — выключаем при посеве. */
export const BROKEN_URLS = [
  'https://finance.yahoo.com/news/rssindex', // 404 с 2026-11: фид закрыт
  'https://www.kitco.com/rss/KitcoNews.xml', // 404
  'https://www.gold.org/rss/news', // 404
  'https://www.banki.ru/xml/news.rss', // 200, но это не фид
  'https://bcs-express.ru/rss', // 200, но это не фид
  'https://rssexport.rbc.ru/rbcnews/news/30/full.rss', // таймаут с Pi
  'https://www.reddit.com/r/LocalLLaMA/.rss', // 429 с Pi: Reddit режет частые запросы
];

/** Термины профиля для автоисточников Google News. */
export const INTEREST_TERMS = [
  'драгметаллы золото',
  'валюты USD RUB',
  'рынок США акции',
  'IPO',
  'робототехника',
  'биотех',
  'AI-модели',
  'макро ЦБ ставка',
  'Physical AI',
  'промпт-инжиниринг',
];

/** Темы, которые были в раннем наборе и сняты: их Google News отключаем при посеве.
 * «промпт-инжиниринг» снят со списка: владелец называет его глубокой темой, а фид отдаёт
 * релевантные пункты — интерес без источника не оставляем. */
export const RETIRED_TERMS = ['инвест-идеи'];

/**
 * Идемпотентный посев: профиль интересов (если пуст) + набор источников + Google News по темам.
 * Битые адреса из BROKEN_URLS выключаются, если уже лежат в базе.
 * @returns {Promise<{created:number, existing:number, disabled:number, interests:boolean, interestSources:{created:string[],existing:string[]}}>}
 */
export async function seedSources(chatId, { log = console.log } = {}) {
  await ensureUser(chatId);
  let interests = await getInterests(chatId);
  let interestsChanged = false;
  // Профиль, оставленный дописыванием термина в хвост «кратко», переписываем один раз:
  // иначе главная тема читается как второстепенная. Свои правки владельца не трогаем —
  // совпадение должно быть точным.
  const mine = normalizeTerm(interests);
  const legacy = Boolean(mine) && LEGACY_PROFILES.some((profile) => normalizeTerm(profile) === mine);
  if (!String(interests ?? '').trim() || legacy) {
    await setInterests(chatId, DEFAULT_INTERESTS);
    interests = DEFAULT_INTERESTS;
    interestsChanged = true;
  }

  let created = 0;
  let existing = 0;
  for (const source of DEFAULT_PACK) {
    const result = await addSource(chatId, { ...source, origin: 'pack' });
    if (result.created) created += 1;
    else existing += 1;
  }

  let disabled = 0;
  const retiredUrls = RETIRED_TERMS.map((term) => googleNewsUrl(term));
  const { setSourceEnabled } = await import('./store.js');
  for (const row of listSources(chatId)) {
    const broken = BROKEN_URLS.includes(row.url);
    const retired = row.origin === 'interest' && retiredUrls.includes(row.url);
    if ((broken || retired) && row.enabled) {
      await setSourceEnabled(row.id, chatId, false);
      disabled += 1;
    }
  }

  // Google News по терминам интересов: +1 RSS на тему, дальше — обычный сбор.
  const interestSources = await addInterestSources(chatId, INTEREST_TERMS);
  created += interestSources.created.length;
  existing += interestSources.existing.length;

  log(`посев источников: +${created} (в т.ч. по интересам ${interestSources.created.length}), уже были ${existing}, выключено битых ${disabled}, всего ${listSources(chatId).length}`);
  return { created, existing, disabled, interests: interestsChanged, interestSources };
}
