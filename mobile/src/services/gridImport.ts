export async function downloadMasterGridTemplate(): Promise<Blob> {
  const res = await fetch('http://localhost:5001/api/v1/rotations/import/master/template');
  return res.blob();
}
export async function downloadCccTemplate(): Promise<Blob> {
  const res = await fetch('http://localhost:5001/api/v1/rotations/import/ccc/template');
  return res.blob();
}
