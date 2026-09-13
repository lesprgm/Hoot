# View demo

## Start a deterministic demo

Use Node.js 20+ on macOS, then run:

```sh
npm install
cp .env.example .env
SIMULATE_GAZE=true GAZE_PROVIDER=simulated DECODER_PROVIDER=fixture EXECUTOR_PROVIDER=openai EXECUTION_MODE=live npm run dev
```

The mouse supplies gaze coordinates. The fixture selector includes Article, Vertical feed, Email, Shopping, and CU sandbox surfaces. Desktop execution is live-only; set `OPENAI_API_KEY` before confirming a task if you want Astra to operate the desktop.

## Reading mode

Select the Article fixture and remain passive. Press `R` to activate `READING MODE`. Move the mouse to the lower 22% of the article and hold for 650 ms to scroll down 320 px. Move to the upper 15% and hold for 700 ms to scroll up. The center does nothing, and the 550 ms cooldown prevents runaway repeats. Press `R` again or `X` to leave the mode.

## Vertical-feed mode

Select the Vertical feed fixture and press `F` while passive. Hold the mouse in the lower 18% for 600 ms to advance one card, or the upper 18% to move back one card. The center remains a viewing area. Press `F` again or `X` to leave the mode.

## Semantic execution and recovery

Press `N` to summon the agent, then use keys `1`–`4` or gaze dwell to select options. `B` goes back, `M` requests more choices, `H` opens hint entry, and `X` exits. Confirm an intent with the displayed choice. Consequential actions still require a second confirmation: choose `A` to approve, `B` to change, `C` to read again, or `D` to cancel. If Astra is unavailable or another error occurs, choose retry, go back, choose something else, or stop on the recovery card.

## Live validation

For a live Gemini decoder, set `DECODER_PROVIDER=gemini`, `GEMINI_API_KEY`, and `DECODER_MODEL=gemini-3.5-flash-lite` in `.env`. The Astra Computer Use executor remains a separate OpenAI provider and requires `OPENAI_API_KEY`; without that key, the application shows an executor-unavailable recovery card and does not change the desktop. Grant Camera, Screen Recording, and Accessibility permissions for live gaze and desktop execution. Review the exact intent and every consequential confirmation before approval. Validate the deterministic fixtures first.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The live OpenAI path is not exercised by CI unless credentials and macOS permissions are present.
