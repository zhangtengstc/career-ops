// tests/browser-source.test.mjs
//
// Covers the login-state source framework (lib/browser-source.mjs) and the first
// concrete source (browser-sources/zhaopin.mjs). Only pure logic is exercised —
// no browser is launched, so this suite runs offline and fast. The engine's
// browser path (run/login) is exercised manually via
// `node scan-browser-source.mjs zhaopin --login/--dry-run`.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nLogin-state browser sources (framework + zhaopin)');

try {
  const { BrowserSource, buildTitleFilter } = await import(pathToFileURL(join(ROOT, 'lib/browser-source.mjs')).href);
  const zhaopin = await import(pathToFileURL(join(ROOT, 'browser-sources/zhaopin.mjs')).href);
  const { buildSearchUrl, normalizeJob, parseSalary, resolveCityCode, mapSearchParams, resolveSalaryCode } = zhaopin;

  // ── buildSearchUrl (zhaopin) ────────────────────────────────────
  {
    const u = buildSearchUrl('java', 1);
    if (u.startsWith('https://www.zhaopin.com/jobs?') && u.includes('kw=java') && u.includes('jl=489') && u.includes('kt=3')) {
      pass('buildSearchUrl builds the /jobs search URL (nationwide jl=489 + keyword)');
    } else {
      fail(`buildSearchUrl('java',1) = ${u}`);
    }
  }
  {
    const u = buildSearchUrl('前端 开发', 1, '530');
    if (u.includes('jl=530')) {
      pass('buildSearchUrl attaches the city code and URL-encodes the keyword');
    } else {
      fail(`buildSearchUrl with city = ${u}`);
    }
    if (!buildSearchUrl('java').includes('&p=')) {
      pass('buildSearchUrl does not emit a ?p param (zhaopin paginates client-side)');
    } else {
      fail('buildSearchUrl should not emit a URL-page param');
    }
  }

  // ── resolveCityCode (zhaopin, search-region narrowing) ───────────
  {
    if (resolveCityCode(['上海']) === '538') pass('resolveCityCode: a single known city → its jl code');
    else fail(`resolveCityCode(['上海']) = ${resolveCityCode(['上海'])}`);
    if (resolveCityCode(['上海', 'Shanghai']) === '538') pass('resolveCityCode: CN+EN aliases of the SAME city collapse to one code');
    else fail('resolveCityCode should collapse 上海+Shanghai to 538');
    if (resolveCityCode(['北京']) === '530') pass('resolveCityCode: 北京 → 530');
    else fail('resolveCityCode(北京) should be 530');
    if (resolveCityCode(['上海', '北京']) === null) pass('resolveCityCode: a multi-city allow list → null (nationwide + post-filter)');
    else fail('multi-city allow should resolve to null');
    if (resolveCityCode(['上海', 'Remote']) === null) pass('resolveCityCode: any non-city entry (Remote) → null (nationwide)');
    else fail('a non-city entry should force nationwide');
    if (resolveCityCode(['远程']) === null) pass('resolveCityCode: 远程 is not a city → null');
    else fail('远程 should force nationwide');
    if (resolveCityCode([]) === null && resolveCityCode(undefined) === null) pass('resolveCityCode: empty/absent allow → null');
    else fail('empty/absent allow should be null');
  }

  // ── mapSearchParams / resolveSalaryCode (semantic → codes) ───────
  {
    const full = mapSearchParams(
      { salary: '15-25K', education: '本科', experience: '3-5年', jobStatus: '全职', companyType: '国企', companySize: '1000人以上' },
      ['上海'],
    );
    if (full.jl === '538' && full.sl === '15001,25000' && full.el === '4' && full.we === '0305' && full.et === '2' && full.ct === '1' && full.cs === '6') {
      pass('mapSearchParams: full semantic conditions → jl+sl+el+we+et+ct+cs');
    } else {
      fail(`mapSearchParams(full) = ${JSON.stringify(full)}`);
    }
  }
  {
    const partial = mapSearchParams({ education: '硕士' }, ['上海']);
    if (partial.jl === '538' && partial.el === '3' && partial.sl === undefined && partial.we === undefined && partial.et === undefined) {
      pass('mapSearchParams: partial conditions narrow only the given dimensions');
    } else {
      fail(`mapSearchParams(partial) = ${JSON.stringify(partial)}`);
    }
  }
  {
    const none = mapSearchParams({}, []);
    if (none.jl === '489' && Object.keys(none).length === 1) {
      pass('mapSearchParams: no conditions → nationwide jl=489 only');
    } else {
      fail(`mapSearchParams(empty) = ${JSON.stringify(none)}`);
    }
  }
  {
    // Unknown / empty values are dropped — broad, not wrongly narrowed.
    const unknown = mapSearchParams({ education: '博士后', companyType: '不限' }, []);
    if (unknown.jl === '489' && unknown.el === undefined && unknown.ct === undefined) {
      pass('mapSearchParams: unknown/empty values dropped (stay broad)');
    } else {
      fail(`mapSearchParams(unknown) = ${JSON.stringify(unknown)}`);
    }
  }
  {
    if (
      resolveSalaryCode('15K-25K') === '15001,25000' &&
      resolveSalaryCode('15-25K') === '15001,25000' &&
      resolveSalaryCode('50K以上') === '50001,9999999' &&
      resolveSalaryCode('不限') === null &&
      resolveSalaryCode('面议') === null &&
      resolveSalaryCode('') === null
    ) {
      pass('resolveSalaryCode: labels normalize to codes; 不限/面议/empty → null');
    } else {
      fail('resolveSalaryCode should normalize labels and reject 不限/面议/empty');
    }
  }
  {
    const u = buildSearchUrl('java', 1, { jl: '538', el: '4', sl: '15001,25000' });
    if (u.includes('jl=538') && u.includes('el=4') && u.includes('sl=15001%2C25000')) {
      pass('buildSearchUrl accepts a params object (jl+el+sl, comma URL-encoded)');
    } else {
      fail(`buildSearchUrl(params object) = ${u}`);
    }
  }

  // ── normalizeJob (zhaopin, position-object input) ───────────────
  {
    const job = normalizeJob({
      name: 'Java 开发工程师',
      positionURL: 'http://www.zhaopin.com/jobdetail/CC244376110J40960539408.htm',
      companyName: '某科技公司',
      workCity: '上海',
      cityDistrict: '黄浦',
      streetName: '南京东路',
      salaryReal: '9001-12000',
      publishTime: '2026-08-29 11:05:42',
    });
    if (
      job &&
      job.title === 'Java 开发工程师' &&
      job.url === 'https://www.zhaopin.com/jobdetail/CC244376110J40960539408.htm' &&
      job.company === '某科技公司' &&
      job.location === '上海 黄浦 南京东路' &&
      job.salary &&
      job.salary.min === 9001 &&
      job.salary.max === 12000 &&
      job.salary.currency === 'CNY' &&
      typeof job.postedAt === 'number'
    ) {
      pass('normalizeJob maps a position object (https-normalized url, joined location, salary {min,max,currency}, postedAt)');
    } else {
      fail(`normalizeJob(valid) = ${JSON.stringify(job)}`);
    }
  }
  {
    // Falls back to positionUrl + salaryReal when the display forms are absent.
    const job = normalizeJob({ name: '后端', positionUrl: 'https://www.zhaopin.com/jobdetail/x.htm', salaryReal: '8001-12000' });
    if (job && job.url === 'https://www.zhaopin.com/jobdetail/x.htm' && job.salary && job.salary.min === 8001 && job.salary.max === 12000 && job.postedAt === undefined) {
      pass('normalizeJob falls back to positionUrl + salaryReal and omits a missing date');
    } else {
      fail(`normalizeJob(fallback) = ${JSON.stringify(job)}`);
    }
  }
  {
    if (parseSalary('9000-12000元') && parseSalary('9000-12000元').min === 9000 && parseSalary('9000-12000元').max === 12000) {
      pass('parseSalary parses a "9000-12000元" range into {min,max,CNY}');
    } else {
      fail(`parseSalary(range) = ${JSON.stringify(parseSalary('9000-12000元'))}`);
    }
    if (parseSalary('20000') && parseSalary('20000').min === 20000 && parseSalary('20000').max === 20000) {
      pass('parseSalary keeps a single number as a single-sided bound');
    } else {
      fail(`parseSalary(single) = ${JSON.stringify(parseSalary('20000'))}`);
    }
    if (parseSalary('面议') === null && parseSalary('') === null) {
      pass('parseSalary returns null for non-numeric salary strings');
    } else {
      fail('parseSalary should return null for "面议"/empty');
    }
  }
  {
    if (normalizeJob({ name: '', positionURL: 'https://x/y.htm' }) === null) pass('normalizeJob returns null for a missing title');
    else fail('normalizeJob should drop a position without a name');
    if (normalizeJob({ name: '有标题', positionURL: '' }) === null) pass('normalizeJob returns null for a missing url');
    else fail('normalizeJob should drop a position without a URL');
  }

  // ── buildTitleFilter (framework) ────────────────────────────────
  {
    const f = buildTitleFilter({ positive: ['java', 'python'], negative: ['sales', 'manager'] });
    if (f('Senior Java Engineer') === true) pass('title filter: positive keyword passes');
    else fail('title filter should pass a matching positive');
    if (f('Sales Manager') === false) pass('title filter: negative keyword rejects');
    else fail('title filter should reject a negative match');
    if (f('Frontend Engineer') === false) pass('title filter: no positive match rejects');
    else fail('title filter should reject when no positive matches');
  }
  {
    const f = buildTitleFilter(undefined);
    if (f('anything') === true) pass('title filter with no config passes everything');
    else fail('empty title filter should pass everything');
  }

  // ── resolveKeywords (framework, via a fake source) ──────────────
  {
    /** @type {any} */
    class FakeSource extends BrowserSource {
      searchUrl() {
        return '';
      }
      async extract() {
        return [];
      }
      normalizeJob() {
        return null;
      }
    }
    const make = () =>
      new FakeSource({
        id: 'fake',
        label: 'Fake',
        loginUrl: 'https://example.com',
        defaultKeywords: ['default1', 'default2'],
        configSection: 'fake_searches',
      });

    if (JSON.stringify(make().resolveKeywords({}, 'cliKw')) === JSON.stringify(['cliKw'])) {
      pass('resolveKeywords: an explicit CLI keyword wins');
    } else {
      fail('resolveKeywords should prefer the CLI keyword');
    }

    const fromStrings = make().resolveKeywords({ fake_searches: ['java', '前端'] }, null);
    if (JSON.stringify(fromStrings) === JSON.stringify(['java', '前端'])) {
      pass('resolveKeywords: reads a plain-string list from portals.yml');
    } else {
      fail(`resolveKeywords(strings) = ${JSON.stringify(fromStrings)}`);
    }

    const fromObjects = make().resolveKeywords({ fake_searches: [{ kw: 'java' }, { was: 'python' }] }, null);
    if (JSON.stringify(fromObjects) === JSON.stringify(['java', 'python'])) {
      pass('resolveKeywords: reads {kw}/{was} objects from portals.yml');
    } else {
      fail(`resolveKeywords(objects) = ${JSON.stringify(fromObjects)}`);
    }

    const defaults = make().resolveKeywords({}, null);
    if (JSON.stringify(defaults) === JSON.stringify(['default1', 'default2'])) {
      pass('resolveKeywords: falls back to defaultKeywords when portals.yml is empty');
    } else {
      fail(`resolveKeywords(defaults) = ${JSON.stringify(defaults)}`);
    }
  }

  // ── nextPage hook (framework) ───────────────────────────────────
  {
    /** @type {any} */
    class BaseOnly extends BrowserSource {
      searchUrl() {
        return '';
      }
      async extract() {
        return [];
      }
      normalizeJob() {
        return null;
      }
    }
    /** @type {any} */
    class PagedSource extends BrowserSource {
      constructor() {
        super({ id: 'paged', label: 'Paged', loginUrl: 'https://e.com', defaultKeywords: [], configSection: 'paged_searches' });
        this.advanced = 0;
      }
      searchUrl() {
        return '';
      }
      async extract() {
        return [];
      }
      normalizeJob() {
        return null;
      }
      async nextPage() {
        this.advanced++;
        return true;
      }
    }

    const base = new BaseOnly({ id: 'base', label: 'base', loginUrl: 'https://e.com', defaultKeywords: [], configSection: 'base' });
    if ((await base.nextPage(2)) === false) {
      pass('nextPage: base returns false (single page by default)');
    } else {
      fail('base nextPage should return false');
    }

    const paged = new PagedSource();
    if ((await paged.nextPage(2)) === true && paged.advanced === 1) {
      pass('nextPage: a source can override it to advance pages (client-side pagination hook)');
    } else {
      fail('overridden nextPage should return true and record the advance');
    }
  }
} catch (err) {
  fail(`browser-source suite threw: ${err.message}`);
}
