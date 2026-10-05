export function getCurrentAcademicYear(monthStart: number = 7): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  if (month >= monthStart) {
    return `${year}/${year + 1}`;
  }
  return `${year - 1}/${year}`;
}

export function getAcademicYears(monthStart: number = 7, count: number = 3): string[] {
  const current = getCurrentAcademicYear(monthStart);
  const [start] = current.split('/');
  const startYear = parseInt(start, 10);
  const years: string[] = [];
  for (let i = 0; i < count; i++) {
    const y = startYear + i;
    years.push(`${y}/${y + 1}`);
  }
  return years;
}
