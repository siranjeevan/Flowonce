import { describe, it, expect } from 'vitest';
import { DatasetParser, DatasetParseError } from '../src/replay/dataset/DatasetParser';

describe('Phase 7: DatasetParser (RFC 4180 CSV & JSON Parsing)', () => {
  it('1. Parses standard CSV data with commas and headers', () => {
    const csv = `username,email,role
alice,alice@example.com,admin
bob,bob@example.com,user`;

    const parsed = DatasetParser.parseCSV(csv);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.columns).toEqual(['username', 'email', 'role']);
    expect(parsed.records[0]).toEqual({
      username: 'alice',
      email: 'alice@example.com',
      role: 'admin',
    });
    expect(parsed.records[1]).toEqual({
      username: 'bob',
      email: 'bob@example.com',
      role: 'user',
    });
    expect(parsed.fingerprint).toMatch(/^FP_\d+C_\d+R_[a-f0-9]{8}$/);
  });

  it('2. Correctly handles RFC 4180 quoted fields containing commas', () => {
    const csv = `name,address,company
"Smith, John","123 Main St, Suite 400","Acme, Inc."
"Doe, Jane","456 Oak Ave","Globex, LLC"`;

    const parsed = DatasetParser.parseCSV(csv);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.records[0].name).toBe('Smith, John');
    expect(parsed.records[0].address).toBe('123 Main St, Suite 400');
    expect(parsed.records[0].company).toBe('Acme, Inc.');
  });

  it('3. Correctly handles escaped double quotes ("") within quoted fields', () => {
    const csv = `id,description
1,"He said, ""FlowOnce is awesome!"""
2,"Version ""2.0"" released"`;

    const parsed = DatasetParser.parseCSV(csv);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.records[0].description).toBe('He said, "FlowOnce is awesome!"');
    expect(parsed.records[1].description).toBe('Version "2.0" released');
  });

  it('4. Correctly handles multiline quoted fields with embedded newlines', () => {
    const csv = `id,notes
101,"Line 1
Line 2
Line 3"
102,"Single line"`;

    const parsed = DatasetParser.parseCSV(csv);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.records[0].notes).toBe('Line 1\nLine 2\nLine 3');
    expect(parsed.records[1].notes).toBe('Single line');
  });

  it('5. Correctly handles typed and empty cells', () => {
    const csv = `name,age,active,notes
alice,30,true,
bob,,false,regular user`;

    const parsed = DatasetParser.parseCSV(csv);
    expect(parsed.records[0].name).toBe('alice');
    expect(parsed.records[0].age).toBe(30);
    expect(parsed.records[0].active).toBe(true);
    expect(parsed.records[0].notes).toBe('');

    expect(parsed.records[1].name).toBe('bob');
    expect(parsed.records[1].age).toBe('');
    expect(parsed.records[1].active).toBe(false);
    expect(parsed.records[1].notes).toBe('regular user');
  });

  it('6. Rejects CSVs with duplicate or empty column headers', () => {
    const duplicateHeaders = `name,email,name\nalice,alice@test.com,alice2`;
    expect(() => DatasetParser.parseCSV(duplicateHeaders)).toThrow(DatasetParseError);

    const emptyHeader = `name,,role\nalice,test,admin`;
    expect(() => DatasetParser.parseCSV(emptyHeader)).toThrow(DatasetParseError);
  });

  it('7. Rejects column headers colliding with reserved system variables', () => {
    const collisionCsv = `username,_sessionId,role\nalice,ses_1,admin`;
    expect(() => DatasetParser.parseCSV(collisionCsv)).toThrow(DatasetParseError);
  });

  it('8. Enforces required columns if specified in options', () => {
    const csv = `username,role\nalice,admin`;
    expect(() => {
      DatasetParser.parseCSV(csv, { requiredColumns: ['username', 'email'] });
    }).toThrow(/missing required column.*email/i);
  });

  it('9. Parses JSON array datasets', () => {
    const json = JSON.stringify([
      { username: 'charlie', age: 25, active: true },
      { username: 'david', age: 40, active: false },
    ]);

    const parsed = DatasetParser.parseJSON(json);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.columns).toEqual(['username', 'age', 'active']);
    expect(parsed.records[0]).toEqual({
      username: 'charlie',
      age: 25,
      active: true,
    });
    expect(parsed.records[1]).toEqual({
      username: 'david',
      age: 40,
      active: false,
    });
  });

  it('10. Produces identical deterministic fingerprints for identical content and different fingerprints for different content', () => {
    const csv1 = `name,city\nalice,Seattle\nbob,Austin`;
    const csv2 = `name,city\nalice,Seattle\nbob,Austin`;
    const csv3 = `name,city\nalice,Seattle\nbob,Boston`;

    const p1 = DatasetParser.parseCSV(csv1);
    const p2 = DatasetParser.parseCSV(csv2);
    const p3 = DatasetParser.parseCSV(csv3);

    expect(p1.fingerprint).toBe(p2.fingerprint);
    expect(p1.fingerprint).not.toBe(p3.fingerprint);
  });
});
