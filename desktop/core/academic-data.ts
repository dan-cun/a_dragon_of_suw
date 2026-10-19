import { z } from 'zod';
import type { AcademicRecord, AcademicSection } from '../shared/academic';

const field = z.union([z.string().max(4000), z.number().finite(), z.null()]).optional();
const recordSchema = z.object({
  jxb_id: field, kch: field, kch_id: field, kcmc: z.string().trim().min(1).max(500),
  xm: field, jsxm: field, jsxx: field, rkjs: field, xf: field,
  xqj: field, xqjmc: field, jcs: field, jc: field, jcor: field, zcd: field, oldzc: field,
  cdmc: field, cd_id: field, cdbh: field, xqmc: field, cdxqmc: field, lh: field,
  cj: field, cjbz: field, ksxz: field, kssj: field, sjbh: field, row_id: field,
  ksbz: field, bz: field, ksfs: field, kcxzmc: field,
});
type RawRecord = z.infer<typeof recordSchema>;
function text(value: string | number | null | undefined): string { return value === undefined || value === null ? '' : String(value).trim(); }
function normalize(record: RawRecord, section: AcademicSection, index: number): AcademicRecord {
  const weekday = Number(record.xqj);
  return {
    id: `${text(record.jxb_id) || text(record.sjbh) || text(record.row_id) || text(record.kch)}:${index}`,
    course: record.kcmc, code: text(record.kch) || text(record.kch_id),
    teacher: text(record.xm) || text(record.jsxm) || text(record.jsxx) || text(record.rkjs),
    location: [text(record.cdxqmc) || text(record.xqmc), text(record.cdmc) || text(record.cdbh) || text(record.cd_id)].filter(Boolean).join(' · '),
    timing: section === 'timetable' ? text(record.jcs) || text(record.jc) || text(record.jcor) : text(record.kssj),
    weeks: text(record.zcd) || text(record.oldzc),
    weekday: Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? weekday : null,
    score: text(record.cj), credits: text(record.xf),
    note: section === 'grades' ? text(record.cjbz) : text(record.ksbz) || text(record.bz),
    nature: section === 'exams' ? text(record.ksfs) : text(record.ksxz) || text(record.kcxzmc),
  };
}

export function parseAcademicRecords(value: unknown, section: AcademicSection): AcademicRecord[] {
  const records = z.array(recordSchema).max(10000).safeParse(value);
  if (!records.success) throw new Error(`学校${section === 'timetable' ? '课表' : section === 'grades' ? '成绩' : '考试'}数据结构不符合预期，未覆盖上次查询结果。`);
  return records.data.map((record, index) => normalize(record, section, index));
}

export const academicEndpoints: Record<AcademicSection, { page: string; query: string }> = {
  timetable: { page: '/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default', query: '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151' },
  grades: { page: '/jwglxt/cjcx/cjcx_cxDgXscj.html?gnmkdm=N305005&layout=default', query: '/jwglxt/cjcx/cjcx_cxXsgrcj.html?doType=query&gnmkdm=N305005' },
  exams: { page: '/jwglxt/kwgl/kscx_cxXsksxxIndex.html?gnmkdm=N358105&layout=default', query: '/jwglxt/kwgl/kscx_cxXsksxxIndex.html?doType=query&gnmkdm=N358105' },
};
