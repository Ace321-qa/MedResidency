export async function downloadRosterTemplate(): Promise<Blob> {
  const res = await fetch('http://localhost:5001/api/v1/roster/template');
  return await res.blob();
}

export async function uploadRoster(file: any): Promise<any> {
  const form = new FormData();
  form.append('file', file as any);
  const res = await fetch('http://localhost:5001/api/v1/roster/import', { method: 'POST', body: form });
  return await res.json();
}
