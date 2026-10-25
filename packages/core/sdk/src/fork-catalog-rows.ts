// Database row order is unspecified. Names are unique within a connection.
export const catalogRowsMatch = <Row extends { readonly name: string }>(
  stored: readonly Row[],
  proposed: readonly Row[],
  columns: readonly (keyof Row)[],
): boolean => {
  if (stored.length !== proposed.length) return false;
  const byName = new Map(proposed.map((row) => [row.name, row]));
  return stored.every((row) => {
    const candidate = byName.get(row.name);
    return (
      candidate !== undefined &&
      JSON.stringify(columns.map((column) => row[column])) ===
        JSON.stringify(columns.map((column) => candidate[column]))
    );
  });
};
