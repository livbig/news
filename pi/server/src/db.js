/**
 * Тонкий слой над node:sqlite с тем же API, который использовал прод на платформе
 * (`db.select().from(t).where(...)`, `db.insert(t).values(...)`, `db.$count`).
 * Смысл: store.js перенесён почти дословно, а не переписан на голый SQL — меньше
 * поводов для расхождений с проверенным поведением (119 JS-тестов).
 *
 * Только синхронные вызовы: node:sqlite синхронный, а `await` на нём работает как есть.
 */

import { DatabaseSync } from 'node:sqlite';

const registry = new Map();

class Column {
  constructor(name, type) {
    this.name = name;
    this.type = type;
    this.isPk = false;
    this.autoIncrement = false;
    this.nullable = true;
    this.defaultValue = undefined;
  }

  primaryKey(options = {}) {
    this.isPk = true;
    this.autoIncrement = options.autoIncrement === true;
    this.nullable = false;
    return this;
  }

  notNull(value = true) {
    this.nullable = !value;
    return this;
  }

  default(value) {
    this.defaultValue = value;
    return this;
  }
}

export const integer = (name) => new Column(name, 'INTEGER');
export const text = (name) => new Column(name, 'TEXT');

/** sql`...` — сырой фрагмент DDL/DEFAULT, как в схеме платформы. */
export const sql = (strings, ...values) => ({ __rawSql: String.raw(strings, ...values) });

export function table(name, columns, extra) {
  const t = {
    name,
    columns,
    keyToColumn: new Map(Object.entries(columns).map(([key, col]) => [key, col.name])),
    indexes: [],
  };
  if (typeof extra === 'function') {
    // Платформенная схема обращается к колонкам как t.chatId — отдаём их плоско.
    const ref = Object.assign({}, columns, t);
    for (const idx of Object.values(extra(ref) ?? {})) t.indexes.push(idx);
  }
  // Наружу — тот же объект, но с плоским доступом к колонкам (users.chatId), как в схеме.
  const exported = Object.assign(t, columns);
  registry.set(name, exported);
  return exported;
}

export const index = (name) => ({ on: (...cols) => ({ name, cols, unique: false }) });
export const uniqueIndex = (name) => ({ on: (...cols) => ({ name, cols, unique: true }) });

const columnName = (t, col) => {
  if (!col || typeof col.name !== 'string') throw new Error(`не колонка: ${String(col)}`);
  return col.name;
};

const defaultValue = (value) => {
  if (value && typeof value === 'object' && typeof value.__rawSql === 'string') return value.__rawSql;
  if (typeof value === 'number') return String(value);
  if (value === null) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
};

/** CREATE TABLE/INDEX для всех объявленных таблиц (миграция платформы заменена этим). */
export function createSchema(database) {
  for (const t of registry.values()) {
    const cols = Object.values(t.columns).map((col) => {
      let ddl = `${col.name} ${col.type}`;
      if (col.isPk) ddl += col.autoIncrement ? ' PRIMARY KEY AUTOINCREMENT' : ' PRIMARY KEY';
      if (!col.nullable && !col.isPk) ddl += ' NOT NULL';
      if (col.defaultValue !== undefined) ddl += ` DEFAULT ${defaultValue(col.defaultValue)}`;
      return ddl;
    });
    database.exec(`CREATE TABLE IF NOT EXISTS ${t.name} (${cols.join(', ')})`);
    for (const idx of t.indexes) {
      const kind = idx.unique ? 'UNIQUE INDEX' : 'INDEX';
      database.exec(`CREATE ${kind} IF NOT EXISTS ${idx.name} ON ${t.name}(${idx.cols.map((col) => columnName(t, col)).join(', ')})`);
    }
  }
}

// --- условия -----------------------------------------------------------------------

const cond = (sqlText, params = []) => ({ sql: sqlText, params });

export const eq = (col, value) => cond(`${columnName(null, col)} = ?`, [value]);
export const gte = (col, value) => cond(`${columnName(null, col)} >= ?`, [value]);
export const lt = (col, value) => cond(`${columnName(null, col)} < ?`, [value]);

/** IN () в SQLite невалиден, пустой список должен давать «ничего не найдено». */
export const inArray = (col, values) => {
  const list = [...(values ?? [])];
  if (!list.length) return cond('0');
  return cond(`${columnName(null, col)} IN (${list.map(() => '?').join(', ')})`, list);
};

export const and = (...parts) => {
  const list = parts.filter(Boolean);
  if (!list.length) return cond('1');
  return cond(list.map((part) => `(${part.sql})`).join(' AND '), list.flatMap((part) => part.params));
};

export const or = (...parts) => {
  const list = parts.filter(Boolean);
  if (!list.length) return cond('1');
  return cond(list.map((part) => `(${part.sql})`).join(' OR '), list.flatMap((part) => part.params));
};

export const asc = (col) => ({ col, dir: 'ASC' });
export const desc = (col) => ({ col, dir: 'DESC' });

// --- запросы -----------------------------------------------------------------------

const bindable = (value) => {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
};

const quoteKey = (key) => `"${key.replace(/"/g, '""')}"`;

class SelectBuilder {
  constructor(database, fields) {
    this.database = database;
    this.fields = fields;
    this.tableRef = null;
    this.whereCond = null;
    this.order = [];
    this.limitValue = null;
    this.offsetValue = null;
  }

  from(tableRef) {
    this.tableRef = tableRef;
    return this;
  }

  where(condition) {
    this.whereCond = condition;
    return this;
  }

  orderBy(...parts) {
    this.order = parts.filter(Boolean);
    return this;
  }

  limit(value) {
    this.limitValue = Number(value);
    return this;
  }

  offset(value) {
    this.offsetValue = Number(value);
    return this;
  }

  build() {
    if (!this.tableRef) throw new Error('select без from');
    let sqlText = 'SELECT ';
    if (!this.fields) {
      // Наружу — camelCase, как отдавала платформа: store.js рассчитывает на эти имена.
      sqlText += Object.entries(this.tableRef.columns)
        .map(([key, col]) => (key === col.name ? key : `${col.name} AS ${quoteKey(key)}`))
        .join(', ');
    } else {
      sqlText += Object.entries(this.fields)
        .map(([key, col]) => {
          const name = columnName(this.tableRef, col);
          return name === key ? name : `${name} AS ${quoteKey(key)}`;
        })
        .join(', ');
    }
    sqlText += ` FROM ${this.tableRef.name}`;
    const params = [];
    if (this.whereCond) {
      sqlText += ` WHERE ${this.whereCond.sql}`;
      params.push(...this.whereCond.params.map(bindable));
    }
    if (this.order.length) {
      sqlText += ` ORDER BY ${this.order
        .map((part) => `${columnName(this.tableRef, part.col)} ${part.dir === 'ASC' ? 'ASC' : 'DESC'}`)
        .join(', ')}`;
    }
    if (Number.isInteger(this.limitValue) && this.limitValue >= 0) sqlText += ` LIMIT ${this.limitValue}`;
    if (Number.isInteger(this.offsetValue) && this.offsetValue > 0) sqlText += ` OFFSET ${this.offsetValue}`;
    return { sqlText, params };
  }

  all() {
    const { sqlText, params } = this.build();
    return this.database.prepare(sqlText).all(...params);
  }

  get() {
    const { sqlText, params } = this.build();
    return this.database.prepare(sqlText).get(...params);
  }
}

class InsertBuilder {
  constructor(database, tableRef, values) {
    this.database = database;
    this.tableRef = tableRef;
    this.rows = Array.isArray(values) ? values : [values];
    this.wantReturning = false;
  }

  returning() {
    this.wantReturning = true;
    return this;
  }

  run() {
    if (!this.rows.length) return [];
    const keys = Object.keys(this.rows[0]);
    const cols = keys.map((key) => {
      const name = this.tableRef.keyToColumn.get(key);
      if (!name) throw new Error(`таблица ${this.tableRef.name}: нет колонки ${key}`);
      return name;
    });
    const placeholders = this.rows.map(() => `(${keys.map(() => '?').join(', ')})`).join(', ');
    const params = this.rows.flatMap((row) => keys.map((key) => bindable(row[key])));
    const sqlText = `INSERT INTO ${this.tableRef.name} (${cols.join(', ')}) VALUES ${placeholders}${this.wantReturning ? ' RETURNING *' : ''}`;
    const statement = this.database.prepare(sqlText);
    if (this.wantReturning) return statement.all(...params);
    statement.run(...params);
    return [];
  }
}

class UpdateBuilder {
  constructor(database, tableRef, patch) {
    this.database = database;
    this.tableRef = tableRef;
    this.patch = patch;
    this.whereCond = null;
  }

  set(patch) {
    this.patch = { ...this.patch, ...patch };
    return this;
  }

  where(condition) {
    this.whereCond = condition;
    return this;
  }

  run() {
    const keys = Object.keys(this.patch);
    if (!keys.length) return [];
    const sets = keys.map((key) => {
      const name = this.tableRef.keyToColumn.get(key);
      if (!name) throw new Error(`таблица ${this.tableRef.name}: нет колонки ${key}`);
      return `${name} = ?`;
    });
    const params = keys.map((key) => bindable(this.patch[key]));
    let sqlText = `UPDATE ${this.tableRef.name} SET ${sets.join(', ')}`;
    if (this.whereCond) {
      sqlText += ` WHERE ${this.whereCond.sql}`;
      params.push(...this.whereCond.params.map(bindable));
    }
    return this.database.prepare(sqlText).run(...params);
  }
}

class DeleteBuilder {
  constructor(database, tableRef) {
    this.database = database;
    this.tableRef = tableRef;
    this.whereCond = null;
  }

  where(condition) {
    this.whereCond = condition;
    return this;
  }

  run() {
    let sqlText = `DELETE FROM ${this.tableRef.name}`;
    const params = [];
    if (this.whereCond) {
      sqlText += ` WHERE ${this.whereCond.sql}`;
      params.push(...this.whereCond.params.map(bindable));
    }
    return this.database.prepare(sqlText).run(...params);
  }
}

export function openDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL');
  // SD-карта на Pi: FULL fsync на каждую вставку вешает event loop. WAL+NORMAL теряет
  // максимум последние транзакции при отключении питания, а не целостность базы.
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA busy_timeout = 15000');
  database.exec('PRAGMA foreign_keys = ON');
  createSchema(database);
  return {
    raw: database,
    select: (fields) => new SelectBuilder(database, fields),
    insert: (tableRef) => new InsertBuilder(database, tableRef, {}),
    update: (tableRef) => new UpdateBuilder(database, tableRef, {}),
    delete: (tableRef) => new DeleteBuilder(database, tableRef),
    $count: (tableRef, condition) => {
      let sqlText = `SELECT COUNT(*) AS c FROM ${tableRef.name}`;
      const params = [];
      if (condition) {
        sqlText += ` WHERE ${condition.sql}`;
        params.push(...condition.params.map(bindable));
      }
      return Number(database.prepare(sqlText).get(...params)?.c ?? 0);
    },
    exec: (sqlText) => database.exec(sqlText),
    /** Синхронная транзакция: пачка вставок — один fsync вместо сотни. */
    transaction: (fn) => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          /* транзакция уже откатилась */
        }
        throw error;
      }
    },
    close: () => database.close(),
  };
}

// insert().values() — в стиле платформы: значения передаются после создания билдера.
InsertBuilder.prototype.values = function values(payload) {
  this.rows = Array.isArray(payload) ? payload : [payload];
  return this;
};
