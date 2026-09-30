export function unwrap(result, fallbackMessage = "Database request failed.") {
  if (result.error) throw new Error(result.error.message || fallbackMessage);
  return result.data;
}
