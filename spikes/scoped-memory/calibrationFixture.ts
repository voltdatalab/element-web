/*
Copyright 2026 Volt Data Lab

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Data-only contract for a small abstention calibration fixture. */
interface CalibrationFixture {
    name: string;
    passages: readonly string[];
    queries: readonly {
        id: string;
        question: string;
        answerable: boolean;
    }[];
}

/**
 * Projeto inteiramente fictício, com rótulos sintéticos, sem anotação humana.
 * A respondibilidade considera apenas os textos deste conjunto independente.
 */
export const calibrationFixture: CalibrationFixture = {
    name: "Farol — rótulos sintéticos, sem anotação humana",
    passages: [
        "No projeto fictício Farol, a mostra acontece na sala das Nuvens.",
        "Os painéis da mostra do Farol são feitos de papelão reaproveitado.",
        "A equipe de montagem organiza a mostra do Farol.",
        "A visitação da mostra do Farol começa às 16h30.",
    ],
    queries: [
        {
            id: "farol-01",
            question: "Em que espaço vai acontecer a exposição do Farol?",
            answerable: true,
        },
        {
            id: "farol-02",
            question: "Quanto custa a entrada para a mostra do Farol?",
            answerable: false,
        },
        {
            id: "farol-03",
            question: "De que são feitos os painéis da mostra do Farol?",
            answerable: true,
        },
        {
            id: "farol-04",
            question: "Quem forneceu o material dos painéis do Farol?",
            answerable: false,
        },
        {
            id: "farol-05",
            question: "Quem cuida da organização da mostra do Farol?",
            answerable: true,
        },
        {
            id: "farol-06",
            question: "Quantas pessoas integram a equipe que organiza a mostra do Farol?",
            answerable: false,
        },
        {
            id: "farol-07",
            question: "Qual é o horário de abertura da mostra do Farol?",
            answerable: true,
        },
        {
            id: "farol-08",
            question: "Até que horas a mostra do Farol fica aberta?",
            answerable: false,
        },
    ],
};
