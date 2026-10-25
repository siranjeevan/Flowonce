import { RESERVED_SYSTEM_VARS } from '../VariableContext';

export interface DatasetParseOptions {
  maxRows?: number;
  maxSizeBytes?: number;
  requiredColumns?: string[];
}

export interface ParsedDataset {
  records: Record<string, string | number | boolean | null>[];
  columns: string[];
  rowCount: number;
  fingerprint: string;
}

export class DatasetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetParseError';
  }
}

const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Robust CSV and JSON parser with RFC 4180 compliance,
 * quoted/escaped field handling, schema validation, and fingerprinting.
 */
export class DatasetParser {
  /**
   * Parses CSV string into a validated dataset.
   */
  public static parseCSV(csvContent: string, options: DatasetParseOptions = {}): ParsedDataset {
    if (!csvContent || typeof csvContent !== 'string' || !csvContent.trim()) {
      throw new DatasetParseError('CSV content is empty');
    }

    const maxSizeBytes = options.maxSizeBytes || DEFAULT_MAX_SIZE_BYTES;
    if (csvContent.length > maxSizeBytes) {
      throw new DatasetParseError(`CSV exceeds maximum size limit of ${maxSizeBytes} bytes`);
    }

    const rawRows = this.tokenizeCSV(csvContent);
    if (rawRows.length === 0) {
      throw new DatasetParseError('CSV contains no data rows');
    }

    // First row is headers
    const headerRow = rawRows[0];
    const columns: string[] = [];
    const seenCols = new Set<string>();

    for (let i = 0; i < headerRow.length; i++) {
      const col = headerRow[i].trim();
      if (!col) {
        throw new DatasetParseError(`CSV column ${i + 1} has an empty header name`);
      }
      if (seenCols.has(col)) {
        throw new DatasetParseError(`Duplicate CSV column header: "${col}"`);
      }
      if (RESERVED_SYSTEM_VARS.has(col) || col.startsWith('_')) {
        throw new DatasetParseError(`Column header "${col}" collides with reserved system variable`);
      }
      seenCols.add(col);
      columns.push(col);
    }

    if (columns.length === 0) {
      throw new DatasetParseError('CSV must define at least one header column');
    }

    // Verify required columns if configured
    if (options.requiredColumns) {
      for (const reqCol of options.requiredColumns) {
        if (!seenCols.has(reqCol)) {
          throw new DatasetParseError(`CSV is missing required column: "${reqCol}"`);
        }
      }
    }

    const maxRows = options.maxRows || DEFAULT_MAX_ROWS;
    const records: Record<string, string | number | boolean | null>[] = [];

    for (let r = 1; r < rawRows.length; r++) {
      const row = rawRows[r];
      // Skip empty trailing rows
      if (row.length === 1 && !row[0].trim()) continue;

      if (records.length >= maxRows) {
        throw new DatasetParseError(`Dataset row count exceeds allowed limit of ${maxRows} records`);
      }

      const record: Record<string, string | number | boolean | null> = {};
      for (let c = 0; c < columns.length; c++) {
        const colName = columns[c];
        const rawVal = c < row.length ? row[c] : '';
        record[colName] = this.inferValue(rawVal);
      }
      records.push(record);
    }

    if (records.length === 0) {
      throw new DatasetParseError('CSV contains headers but no data records');
    }

    const fingerprint = this.computeFingerprint(columns, records);

    return {
      records,
      columns,
      rowCount: records.length,
      fingerprint,
    };
  }

  /**
   * Parses JSON string or array into a validated dataset.
   */
  public static parseJSON(jsonContent: string | unknown, options: DatasetParseOptions = {}): ParsedDataset {
    let rawData: unknown;
    if (typeof jsonContent === 'string') {
      if (!jsonContent.trim()) {
        throw new DatasetParseError('JSON content is empty');
      }
      try {
        rawData = JSON.parse(jsonContent);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid JSON';
        throw new DatasetParseError(`Malformed JSON input: ${msg}`);
      }
    } else {
      rawData = jsonContent;
    }

    let rawList: unknown[];
    if (Array.isArray(rawData)) {
      rawList = rawData;
    } else if (rawData && typeof rawData === 'object') {
      const obj = rawData as Record<string, unknown>;
      if (Array.isArray(obj.records)) {
        rawList = obj.records;
      } else if (Array.isArray(obj.data)) {
        rawList = obj.data;
      } else {
        throw new DatasetParseError('JSON object must be an array of records or contain a "records" or "data" array');
      }
    } else {
      throw new DatasetParseError('JSON must be an array of objects');
    }

    if (rawList.length === 0) {
      throw new DatasetParseError('JSON dataset contains no records');
    }

    const maxRows = options.maxRows || DEFAULT_MAX_ROWS;
    if (rawList.length > maxRows) {
      throw new DatasetParseError(`JSON dataset exceeds allowed limit of ${maxRows} records`);
    }

    // Collect all column names across objects
    const seenCols = new Set<string>();
    const columns: string[] = [];

    for (let i = 0; i < rawList.length; i++) {
      const item = rawList[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new DatasetParseError(`Record at index ${i} is not a valid JSON object`);
      }
      for (const key of Object.keys(item as Record<string, unknown>)) {
        if (!seenCols.has(key)) {
          if (RESERVED_SYSTEM_VARS.has(key) || key.startsWith('_')) {
            throw new DatasetParseError(`Column "${key}" at record ${i} collides with reserved system variable`);
          }
          seenCols.add(key);
          columns.push(key);
        }
      }
    }

    if (columns.length === 0) {
      throw new DatasetParseError('JSON records contain no key-value pairs');
    }

    if (options.requiredColumns) {
      for (const reqCol of options.requiredColumns) {
        if (!seenCols.has(reqCol)) {
          throw new DatasetParseError(`JSON dataset is missing required column: "${reqCol}"`);
        }
      }
    }

    const records: Record<string, string | number | boolean | null>[] = [];
    for (const item of rawList) {
      const obj = item as Record<string, unknown>;
      const record: Record<string, string | number | boolean | null> = {};
      for (const col of columns) {
        const val = obj[col];
        if (val === undefined || val === null) {
          record[col] = null;
        } else if (typeof val === 'boolean' || typeof val === 'number' || typeof val === 'string') {
          record[col] = val;
        } else {
          record[col] = JSON.stringify(val);
        }
      }
      records.push(record);
    }

    const fingerprint = this.computeFingerprint(columns, records);

    return {
      records,
      columns,
      rowCount: records.length,
      fingerprint,
    };
  }

  /**
   * RFC 4180 compliant CSV tokenizer supporting quotes, escaped quotes,
   * commas, and multiline values.
   */
  private static tokenizeCSV(text: string): string[][] {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = '';
    let insideQuotes = false;
    let i = 0;
    const len = text.length;

    while (i < len) {
      const char = text[i];

      if (insideQuotes) {
        if (char === '"') {
          // Check for escaped quote ("")
          if (i + 1 < len && text[i + 1] === '"') {
            currentField += '"';
            i += 2;
            continue;
          } else {
            // Closing quote
            insideQuotes = false;
            i++;
            continue;
          }
        } else {
          currentField += char;
          i++;
          continue;
        }
      } else {
        if (char === '"') {
          insideQuotes = true;
          i++;
          continue;
        } else if (char === ',') {
          currentRow.push(currentField);
          currentField = '';
          i++;
          continue;
        } else if (char === '\r') {
          // Check for CRLF
          if (i + 1 < len && text[i + 1] === '\n') {
            i++;
          }
          currentRow.push(currentField);
          currentField = '';
          rows.push(currentRow);
          currentRow = [];
          i++;
          continue;
        } else if (char === '\n') {
          currentRow.push(currentField);
          currentField = '';
          rows.push(currentRow);
          currentRow = [];
          i++;
          continue;
        } else {
          currentField += char;
          i++;
          continue;
        }
      }
    }

    // Flush last field and row
    if (insideQuotes) {
      throw new DatasetParseError('Unclosed quote in CSV data');
    }

    if (currentField.length > 0 || currentRow.length > 0) {
      currentRow.push(currentField);
      rows.push(currentRow);
    }

    return rows;
  }

  /**
   * Infers primitive types for parsed CSV strings (booleans, numbers, nulls).
   */
  private static inferValue(val: string): string | number | boolean | null {
    const trimmed = val.trim();
    if (trimmed === '') return '';
    if (trimmed.toLowerCase() === 'null') return null;
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;

    // Strict number check (prevent "123-456" from becoming NaN or partial number)
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!isNaN(num)) return num;
    }

    return trimmed;
  }

  /**
   * Generates a deterministic content fingerprint (FNV-1a 64-bit hex hash).
   */
  public static computeFingerprint(
    columns: string[],
    records: Record<string, string | number | boolean | null>[]
  ): string {
    const serialized = JSON.stringify({ columns, records });
    let hash = 0x811c9dc5;
    for (let i = 0; i < serialized.length; i++) {
      hash ^= serialized.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return `FP_${columns.length}C_${records.length}R_${hash.toString(16).padStart(8, '0')}`;
  }
}
