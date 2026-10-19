type Operation = 'portal' | 'portal-resource' | 'timetable' | 'grades' | 'exams';

export async function readAcademicResponse<T extends { status: number }>(read: () => Promise<T>, operation: Operation): Promise<T> {
  const first = await read();
  if (![502, 503, 504].includes(first.status)) return first;
  console.warn(JSON.stringify({ event: 'academic.read.retry', operation, httpStatus: first.status, attempt: 1, maxAttempts: 2 }));
  await Bun.sleep(300);
  return await read();
}
