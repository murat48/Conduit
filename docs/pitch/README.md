# Conduit pitch deck

Five slides following the supplied Build on Stellar Hackathon PDF: cover, solution, PMF, technical workflow, team. All slide copy and speaker notes are in English.

- `Conduit-Pitch-Deck.pdf`: presentation-ready export.
- `Conduit-Pitch-Deck.pptx`: editable text, shapes and links; speaker notes included.
- `Speaker-Notes.md`: pitch script and source notes.
- `build-deck.cjs`: shared layout source for both exports.

The paper texture is extracted from the user-supplied template for use in this deck. Layout retains its cream, gold and dark palette. The event date and organizer confidentiality line are omitted from the project cover. No claim of organizer endorsement is made.

Team name comes from package.json; role awaits confirmation. A monogram is used because no photo was supplied. PMF is labeled as a hypothesis. No adoption, revenue, market-size or award claims are introduced. Demo availability and deployed contract state were not checked; product claims are based on the local README and implementation.

Rebuild with Node.js and `pdfkit` + `pptxgenjs` available to Node; DejaVu fonts are used. This environment: `NODE_PATH=/tmp/conduit-pitch-tools/node_modules node docs/pitch/build-deck.cjs`.
