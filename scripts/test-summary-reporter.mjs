// Machine-readable summaries are kept separate from test output and credentials.
export default async function* report(events) {
  for await (const event of events) {
    if (event.type === 'test:summary' || event.type === 'test:coverage') yield JSON.stringify(event) + '\n';
  }
}
