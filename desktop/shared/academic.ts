import { z } from 'zod';
import type { Result } from './contracts';

export const academicSectionSchema = z.enum(['timetable', 'grades', 'exams']);
export type AcademicSection = z.infer<typeof academicSectionSchema>;
export const semesterSchema = z.object({ year: z.string().regex(/^\d{4}$/), term: z.enum(['3', '12', '16']), label: z.string().min(1).max(100) });
export type Semester = z.infer<typeof semesterSchema>;
export const academicRecordSchema = z.object({
  id: z.string(), course: z.string().min(1), code: z.string(), teacher: z.string(),
  location: z.string(), timing: z.string(), weeks: z.string(),
  weekday: z.number().int().min(1).max(7).nullable(),
  score: z.string(), credits: z.string(), note: z.string(), nature: z.string(),
});
export type AcademicRecord = z.infer<typeof academicRecordSchema>;
export const academicDatasetSchema = z.object({
  section: academicSectionSchema, semester: semesterSchema,
  updatedAt: z.iso.datetime(), records: z.array(academicRecordSchema).max(10000),
});
export type AcademicDataset = z.infer<typeof academicDatasetSchema>;
export const academicStateSchema = z.object({
  status: z.enum(['disconnected', 'login-required', 'ready']), account: z.string().nullable(),
  message: z.string(), connectedAt: z.iso.datetime().nullable(),
  semesters: z.array(semesterSchema).max(100), selected: semesterSchema.nullable(),
  datasets: z.array(academicDatasetSchema).max(3),
});
export type AcademicState = z.infer<typeof academicStateSchema>;
export const academicCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('state') }).strict(),
  z.object({ command: z.literal('connect') }).strict(),
  z.object({ command: z.literal('check') }).strict(),
  z.object({ command: z.literal('portal') }).strict(),
  z.object({ command: z.literal('disconnect') }).strict(),
  z.object({ command: z.literal('refresh'), section: academicSectionSchema, semester: semesterSchema }).strict(),
]);
export type AcademicCommand = z.infer<typeof academicCommandSchema>;
declare global {
  interface Window { academic: { execute(command: AcademicCommand): Promise<Result<AcademicState>> } }
}
