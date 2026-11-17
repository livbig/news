/**
 * Стенд e2e: временный каталог данных ассистента (пять хранилищ), временный каталог агента pi
 * (`PI_CODING_AGENT_DIR`) с моделями на фейковый сервер и рабочий каталог сессии.
 *
 * Базы и сметы создаются настоящим кодом ассистента (`src/db`, `src/stores`), а не SQL в тесте:
 * схема живёт в одном месте, и фикстура не разойдётся с ней.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Каталог ассистента: его инструменты — часть проверяемого пути, а не заглушка.
 *  Пакет моста живёт в двух местах (`self/news/pi/bridge` и `self/pi-telegram-bridge`),
 *  поэтому ищем ассистента по обоим относительным путям — иначе e2e молча пропускается. */
const ASSISTANT_CANDIDATES = [resolve(REPO, '../../perimetr/assistant'), resolve(REPO, '../../../../perimetr/assistant')];
export const ASSISTANT_DIR =
	process.env.E2E_ASSISTANT_DIR?.trim() || ASSISTANT_CANDIDATES.find((dir) => existsSync(dir)) || ASSISTANT_CANDIDATES[0];

export const assistantAvailable = () => existsSync(join(ASSISTANT_DIR, 'extensions/assistant.js'));

const ROWS = [
	{
		section: 'Оборудование',
		sku: 'DH-IPC-HDW1431T1P-A-0280B-S6',
		name: 'Уличная купольная IP-видеокамера с ИК-подсветкой до 30м',
		unit: 'шт',
		qty: 4,
		price: 7190,
		sum: 28760,
	},
	{
		section: 'Работы',
		sku: 'camera_install_standard',
		name: 'Монтаж и юстировка камеры, стандарт',
		unit: 'шт',
		qty: 4,
		price: 4500,
		sum: 18000,
	},
	{
		section: 'Прочее',
		sku: 'transport',
		name: 'Транспортные расходы',
		unit: 'день',
		qty: 1,
		price: 1500,
		sum: 1500,
	},
];
const TOTAL = 48260;

async function assistantModule(relative) {
	return import(pathToFileURL(join(ASSISTANT_DIR, relative)).href);
}

/**
 * Стенд целиком: каталоги, базы, фикстуры смет, окружение для дочерних процессов.
 * `modelBaseUrl` — адрес фейковой модели (OpenAI-совместимый).
 */
export async function createFixture({ modelBaseUrl, token, sttBaseUrl, apiRoot }) {
	const root = mkdtempSync(join(tmpdir(), 'pi-tg-e2e-'));
	const data = join(root, 'data');
	const work = join(root, 'work');
	const agent = join(root, 'agent');
	const sessions = join(root, 'sessions');
	for (const dir of [data, join(data, 'outbox'), join(data, 'inbox'), work, agent, sessions]) mkdirSync(dir, { recursive: true });

	const stores = {
		root,
		data,
		work,
		agent,
		sessions,
		catalog: join(data, 'catalog.db'),
		estimates: join(data, 'estimates.db'),
		crm: join(data, 'crm.db'),
		knowledge: join(data, 'memory.db'),
		memory: join(data, 'memory'),
		outbox: join(data, 'outbox'),
	};
	// Модули ассистента читают пути из env при каждом вызове — стенд задаёт их один раз.
	Object.assign(process.env, {
		CATALOG_DB: stores.catalog,
		ESTIMATES_DB: stores.estimates,
		CRM_DB: stores.crm,
		KNOWLEDGE_DB: stores.knowledge,
		MEMORY_DIR: stores.memory,
		WORK_DIR: work,
		LOGS_DIR: join(data, 'logs'),
	});

	const [{ openCrmDb, openEstimatesDb, openKnowledgeDb }, { upsertObject }, { createEstimate }, { upsertClient }] =
		await Promise.all([
			assistantModule('src/db/index.js'),
			assistantModule('src/stores/objects.js'),
			assistantModule('src/stores/estimates.js'),
			assistantModule('src/stores/crm.js'),
		]);
	openKnowledgeDb(stores.knowledge).close();

	const estimates = openEstimatesDb(stores.estimates);
	const crm = openCrmDb(stores.crm);
	const seeded = {};
	try {
		const warehouse = upsertObject(estimates, { label: 'Склад Дзержинский', type: 'склад' });
		seeded.estimateWithPhone = createEstimate(estimates, {
			objectId: warehouse.id,
			payload: { rows: ROWS, total: TOTAL, sections: [] },
			total: TOTAL,
			source: 'e2e',
		});
		const client = upsertClient(crm, {
			name: 'ООО «Ромашка»',
			contacts: [{ kind: 'phone', value: '+7 916 555 43 21' }],
			objectId: warehouse.id,
			stage: 'смета отправлена',
		});
		seeded.dealId = client.deal.id;
		seeded.phone4 = '4321';

		const house = upsertObject(estimates, { label: 'Дом без телефона', type: 'дом' });
		seeded.estimateWithoutPhone = createEstimate(estimates, {
			objectId: house.id,
			payload: { rows: ROWS, total: TOTAL, sections: [] },
			total: TOTAL,
			source: 'e2e',
		});
		upsertClient(crm, { name: 'Иванов Пётр', objectId: house.id, stage: 'лид' });

		// Итог не влезает в кольцо на первой странице — самопроверка документа обязана это поймать.
		const broken = upsertObject(estimates, { label: 'Объект с битым итогом', type: 'склад' });
		seeded.brokenEstimate = createEstimate(estimates, {
			objectId: broken.id,
			payload: {
				rows: [{ section: 'Оборудование', sku: 'X', name: 'Камера', unit: 'шт', qty: 1, price: 999_999_999_999, sum: 999_999_999_999 }],
				total: 999_999_999_999,
				sections: [],
			},
			total: 999_999_999_999,
			source: 'e2e',
		});
	} finally {
		estimates.close();
		crm.close();
	}

	// Каталог агента: только фейковая модель, никаких чужих расширений, пакетов и логинов.
	writeFileSync(
		join(agent, 'models.json'),
		`${JSON.stringify(
			{
				providers: {
					e2e: {
						baseUrl: modelBaseUrl,
						api: 'openai-completions',
						apiKey: 'e2e-key',
						models: [
							{
								id: 'e2e-model',
								name: 'E2E Model',
								input: ['text'],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 32_000,
								maxOutputTokens: 2048,
								reasoning: false,
							},
						],
					},
				},
			},
			null,
			2,
		)}\n`,
		'utf8',
	);
	// Расширение ассистента подключено как локальный пакет агента — тот же способ, что на Pi
	// (`pi install ./extensions/assistant.js` пишет именно это). Флагов CLI не нужно.
	writeFileSync(
		join(agent, 'settings.json'),
		`${JSON.stringify({ defaultModel: 'e2e/e2e-model', packages: [join(ASSISTANT_DIR, 'extensions/assistant.js')] }, null, 2)}\n`,
		'utf8',
	);
	// Боевые правила агента уезжают в рабочий каталог сессии — как на Pi.
	const rules = join(ASSISTANT_DIR, 'deploy/work/AGENTS.md');
	if (existsSync(rules)) cpSync(rules, join(work, 'AGENTS.md'));

	/** Окружение дочерних процессов: мост, pi и напоминания видят один и тот же стенд. */
	const env = {
		PI_TG_BOT_TOKEN: token,
		PI_TG_API_ROOT: apiRoot,
		PI_TG_ALLOWED_USER_IDS: '1001',
		PI_TG_DATA_DIR: data,
		PI_TG_LOG_DIR: join(data, 'logs'),
		PI_TG_STATE_FILE: join(root, 'state.json'),
		PI_TG_CWD: work,
		PI_TG_RICH: 'off',
		PI_TG_DRAFT: 'off',
		PI_TG_LOG: 'info',
		PI_TG_CLI_PATH: join(REPO, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
		PI_CODING_AGENT_DIR: agent,
		PI_CODING_AGENT_SESSION_DIR: sessions,
		PI_OFFLINE: '1',
		PI_SKIP_VERSION_CHECK: '1',
		PI_TELEMETRY: '0',
		OPENROUTER_API_KEY: 'e2e-stt-key',
		STT_BASE_URL: sttBaseUrl,
		TELEGRAM_API_BASE: apiRoot,
		TELEGRAM_BOT_TOKEN: token,
		OWNER_CHAT_ID: '1001',
		CATALOG_DB: stores.catalog,
		ESTIMATES_DB: stores.estimates,
		CRM_DB: stores.crm,
		KNOWLEDGE_DB: stores.knowledge,
		MEMORY_DIR: stores.memory,
		WORK_DIR: work,
		LOGS_DIR: join(data, 'logs'),
	};

	return {
		...stores,
		seeded,
		env,
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
