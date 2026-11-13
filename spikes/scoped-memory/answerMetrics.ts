/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

/** Lexical quote/label agreement only; this is not a semantic-support or factuality test. */
export function scoreQuotedAnswer(actual: string, expected: string): { exact: boolean; tokenF1: number } {
    const normalize = (text: string): string =>
        text
            .normalize("NFC")
            .toLowerCase()
            .replace(/\p{P}/gu, (mark: string, index: number, input: string) => {
                const beforeNumber = /\p{N}$/u.test(input.slice(0, index));
                const afterNumber = /^\p{N}/u.test(input.slice(index + mark.length));
                // Preserve numeric signs/units across whitespace, and internal numeric separators.
                if (
                    (mark === "-" && /^\s*\p{N}/u.test(input.slice(index + mark.length))) ||
                    (mark === "%" && /\p{N}\s*$/u.test(input.slice(0, index))) ||
                    (/[.,:/]/u.test(mark) && beforeNumber && afterNumber)
                )
                    return mark;
                return " ";
            })
            .replace(/\s+/gu, " ")
            .trim();
    const normalizedActual = normalize(actual);
    const normalizedExpected = normalize(expected);
    const exact = normalizedActual === normalizedExpected;
    const actualTokens = normalizedActual ? normalizedActual.split(" ") : [];
    const expectedTokens = normalizedExpected ? normalizedExpected.split(" ") : [];
    if (!actualTokens.length || !expectedTokens.length) return { exact, tokenF1: Number(exact) };
    const remaining = new Map<string, number>();
    for (const token of expectedTokens) remaining.set(token, (remaining.get(token) ?? 0) + 1);
    let overlap = 0;
    for (const token of actualTokens) {
        const count = remaining.get(token) ?? 0;
        if (count > 0) {
            overlap++;
            remaining.set(token, count - 1);
        }
    }
    return { exact, tokenF1: (2 * overlap) / (actualTokens.length + expectedTokens.length) };
}
