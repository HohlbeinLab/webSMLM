from __future__ import annotations

import re
import shutil
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote

# Paths
RTD_DIR = Path(__file__).resolve().parent
DOCS_DIR = RTD_DIR.parent

# The single documentation source that you edit manually.
SOURCE_MD = DOCS_DIR / "DOCUMENTATION.md"

# Generated Markdown files consumed by Sphinx/MyST.
CONTENT_DIR = RTD_DIR / "content"
INDEX_MD = RTD_DIR / "index.md"


# Markdown patterns

# Any ATX Markdown heading:
#
#   # Title
#   ## Section
#   ### Subsection
#
HEADING_RE = re.compile(
    r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$"
)

# A level-2 heading only.
#
# Every ## heading in DOCUMENTATION.md becomes a separate RTD page.
H2_RE = re.compile(
    r"^##(?!#)[ \t]+(.+?)[ \t]*#*[ \t]*$"
)

# Internal Markdown fragment:
#
#   [§4](#4-settings-json-format)
#
# Images are deliberately excluded by (?<!\!).
INTERNAL_LINK_RE = re.compile(
    r"(?<!\!)\[([^\]]+)\]\(#([^)]+)\)"
)

# Optional explicit Markdown heading ID:
#
#   ## Settings {#settings}
#
EXPLICIT_ID_RE = re.compile(
    r"^(.*?)[ \t]+\{#([A-Za-z0-9_.:-]+)\}[ \t]*$"
)

# Markdown links/images pointing into docs/images:
#
#   ![Image](images/example.png)
#   ![Image](./images/example.png)
#   [file](images/example.svg)
#
ASSET_LINK_RE = re.compile(
    r"(\]\()(<)?(?:\./)?images/"
)

# HTML image paths, if DOCUMENTATION.md contains raw HTML.
HTML_IMAGE_RE = re.compile(
    r"""(\bsrc\s*=\s*["'])(?:\./)?images/""",
    flags=re.IGNORECASE,
)


# Data structures

@dataclass
class Heading:
    line_index: int
    level: int
    title: str
    anchor: str
    label: str


@dataclass
class Page:
    title: str | None
    lines: list[str]
    filename: str | None = None
    headings: list[Heading] = field(default_factory=list)


# Basic Markdown helpers
def fence_marker(line: str) -> tuple[str, int] | None:
    """
    Detect a fenced code block marker.

    Supports both:

        ```python
        ...

    and:

        ~~~
        ...

    Returns:
        (character, length)

    or None when the line is not a fence.
    """

    match = re.match(
        r"^[ \t]{0,3}(`{3,}|~{3,})",
        line,
    )

    if not match:
        return None

    marker = match.group(1)

    return marker[0], len(marker)


def clean_heading_title(
    raw: str,
) -> tuple[str, str | None]:
    """
    Remove an optional explicit heading ID.

    Example:

        "Settings JSON {#settings-json}"

    becomes:

        ("Settings JSON", "settings-json")
    """

    match = EXPLICIT_ID_RE.match(raw)

    if match:
        return (
            match.group(1).rstrip(),
            match.group(2),
        )

    return raw.strip(), None


def slugify(text: str) -> str:
    """
    Produce a stable ASCII identifier from a Markdown heading.

    Example:

        8 · Headless API (`window.webSMLM`)

    becomes:

        8-headless-api-window-websmlm

    These identifiers are used internally for generated MyST labels
    and generated filenames.
    """

    # Remove inline-code delimiters while keeping their contents.
    text = re.sub(
        r"`([^`]*)`",
        r"\1",
        text,
    )

    # Keep only the visible label of Markdown links.
    text = re.sub(
        r"\[([^\]]+)\]\([^)]+\)",
        r"\1",
        text,
    )

    # Remove common inline Markdown formatting.
    text = re.sub(
        r"[*_~]",
        "",
        text,
    )

    # Remove raw HTML tags.
    text = re.sub(
        r"<[^>]+>",
        "",
        text,
    )

    # Convert accented Unicode characters to a stable ASCII-ish form.
    text = unicodedata.normalize(
        "NFKD",
        text,
    )

    text = "".join(
        char
        for char in text
        if not unicodedata.combining(char)
    )

    text = text.casefold()

    # Everything other than ASCII letters/digits becomes a separator.
    text = re.sub(
        r"[^a-z0-9]+",
        "-",
        text,
    )

    text = re.sub(
        r"-+",
        "-",
        text,
    ).strip("-")

    return text or "section"


def anchor_comparison_key(value: str) -> str:
    """
    Create a punctuation-insensitive representation of an anchor.

    This lets old GitHub-style links continue to work when GitHub and our
    generated slug differ only in punctuation.

    For example all of these effectively compare the same:

        5-table--filter-grammar
        5-table-filter-grammar

        export-camera-aduphoton-conversion
        export-camera-adu-photon-conversion

        gainoffset-estimation-pcfo
        gain-offset-estimation-pcfo
    """

    value = unquote(value)
    value = unicodedata.normalize("NFKD", value)

    value = "".join(
        char
        for char in value
        if not unicodedata.combining(char)
    )

    return re.sub(
        r"[^a-z0-9]+",
        "",
        value.casefold(),
    )


def page_filename(anchor: str) -> str:
    """
    Convert an anchor into a generated Markdown filename.

    Examples:

        1-ui-tour
            -> 01-ui-tour.md

        8-headless-api-window-websmlm
            -> 08-headless-api-window-websmlm.md
    """

    match = re.match(
        r"^(\d+)-(.*)$",
        anchor,
    )

    if match:
        number = int(match.group(1))
        rest = match.group(2) or "section"

        return f"{number:02d}-{rest}.md"

    return f"{anchor}.md"


# Split DOCUMENTATION.md into pages

def split_pages(
    lines: list[str],
) -> tuple[Page, list[Page]]:
    """
    Split DOCUMENTATION.md at level-2 headings.

    Everything before the first ## heading becomes the generated index page.

    Each:

        ## Something

    begins a new generated Markdown page.

    Headings inside fenced code blocks are ignored.
    """

    preamble: list[str] = []
    sections: list[Page] = []

    current_lines: list[str] | None = None
    current_title: str | None = None

    fence_char: str | None = None
    fence_len = 0

    for line in lines:
        fence = fence_marker(line)

        # Only detect headings when outside a fenced code block.
        if fence_char is None:
            match = H2_RE.match(line)

            if match:
                # Finish the previous section.
                if current_lines is not None:
                    sections.append(
                        Page(
                            title=current_title,
                            lines=current_lines,
                        )
                    )

                title, _ = clean_heading_title(
                    match.group(1)
                )

                current_title = title
                current_lines = [line]

                # A heading itself cannot also be a code fence.
                continue

        if current_lines is None:
            preamble.append(line)
        else:
            current_lines.append(line)

        # Update fenced-code state after processing the current line.
        if fence:
            char, length = fence

            if fence_char is None:
                fence_char = char
                fence_len = length

            elif (
                char == fence_char
                and length >= fence_len
            ):
                fence_char = None
                fence_len = 0

    # Store the final section.
    if current_lines is not None:
        sections.append(
            Page(
                title=current_title,
                lines=current_lines,
            )
        )

    return (
        Page(
            title=None,
            lines=preamble,
        ),
        sections,
    )


def remove_trailing_separator(
    lines: list[str],
) -> list[str]:
    """
    Remove a Markdown horizontal rule at the end of a generated page.

    DOCUMENTATION.md may contain:

        end of section

        ---

        ## Next section

    After splitting, the --- should not remain at the bottom of the
    preceding page.
    """

    result = list(lines)

    # Remove trailing empty lines.
    while result and not result[-1].strip():
        result.pop()

    if result:
        last = result[-1].strip()

        # Standard Markdown thematic breaks.
        if re.fullmatch(
            r"(?:-{3,}|\*{3,}|_{3,})",
            last,
        ):
            result.pop()

    # Normalize the ending.
    while result and not result[-1].strip():
        result.pop()

    if result:
        result.append("\n")

    return result


# Heading labels and cross-reference map

def scan_headings(
    pages: list[Page],
) -> dict[str, str]:
    """
    Scan all headings before writing any pages.

    Every heading gets an explicit MyST/Sphinx label:

        (websmlm-4-settings-json-format)=
        # 4 · Settings JSON format

    Returns a mapping:

        source-style anchor -> generated Sphinx label

    This allows links to work even when their target moves to another page.
    """

    used: dict[str, int] = {}
    targets: dict[str, str] = {}

    for page in pages:
        fence_char: str | None = None
        fence_len = 0

        for line_index, line in enumerate(page.lines):
            fence = fence_marker(line)

            if fence:
                char, length = fence

                if fence_char is None:
                    fence_char = char
                    fence_len = length
                    continue

                if (
                    char == fence_char
                    and length >= fence_len
                ):
                    fence_char = None
                    fence_len = 0
                    continue

            if fence_char is not None:
                continue

            match = HEADING_RE.match(line)

            if not match:
                continue

            level = len(match.group(1))

            title, explicit_id = clean_heading_title(
                match.group(2)
            )

            base_anchor = (
                explicit_id
                if explicit_id
                else slugify(title)
            )

            # Ensure globally unique generated labels.
            count = used.get(
                base_anchor,
                0,
            ) + 1

            used[base_anchor] = count

            anchor = (
                base_anchor
                if count == 1
                else f"{base_anchor}-{count}"
            )

            label = f"websmlm-{anchor}"

            page.headings.append(
                Heading(
                    line_index=line_index,
                    level=level,
                    title=title,
                    anchor=anchor,
                    label=label,
                )
            )

            targets[anchor] = label

            # Also allow links using an explicitly declared source ID.
            if explicit_id:
                targets[explicit_id] = label

        # Determine the generated filename from the page's first H2.
        if page.title is not None:
            first_h2 = next(
                (
                    heading
                    for heading in page.headings
                    if heading.level == 2
                ),
                None,
            )

            if first_h2:
                filename_anchor = first_h2.anchor
            else:
                filename_anchor = slugify(page.title)

            page.filename = page_filename(
                filename_anchor
            )

    return targets


def resolve_target(
    target: str,
    targets: dict[str, str],
) -> str:
    """
    Resolve a Markdown #fragment to its generated MyST/Sphinx label.

    Exact matches are preferred.

    If no exact match exists, punctuation-insensitive matching is used
    for compatibility with existing GitHub-style anchors.
    """

    target = unquote(target).strip()

    # Exact match is always preferred.
    if target in targets:
        return targets[target]

    wanted = anchor_comparison_key(target)

    matches = {
        label
        for anchor, label in targets.items()
        if anchor_comparison_key(anchor) == wanted
    }

    if len(matches) == 1:
        return next(iter(matches))

    if len(matches) > 1:
        raise ValueError(
            f"Internal link '#{target}' is ambiguous: "
            "more than one heading matches it."
        )

    # Helpful list for debugging.
    close_matches = [
        anchor
        for anchor in targets
        if (
            wanted in anchor_comparison_key(anchor)
            or anchor_comparison_key(anchor) in wanted
        )
    ]

    suggestion = ""

    if close_matches:
        suggestion = (
            " Possible related headings: "
            + ", ".join(
                f"#{anchor}"
                for anchor in close_matches[:5]
            )
        )

    raise ValueError(
        f"Internal link target '#{target}' does not match any heading "
        f"in docs/DOCUMENTATION.md.{suggestion}"
    )


# Rewriting links/assets for generated Markdown

def rewrite_internal_links(
    line: str,
    targets: dict[str, str],
) -> str:
    """
    Convert same-document Markdown fragment links into native MyST refs.

    Source:

        see [§6](#6-csv-export-format)

    Generated:

        see {ref}`§6 <websmlm-6-csv-export-format>`

    Unlike a normal #fragment, this continues working when §6 lives in a
    different generated Markdown page.
    """

    def replace(
        match: re.Match[str],
    ) -> str:
        visible_text = match.group(1)
        target = match.group(2)

        label = resolve_target(
            target,
            targets,
        )

        return (
            f"{{ref}}`{visible_text} "
            f"<{label}>`"
        )

    return INTERNAL_LINK_RE.sub(
        replace,
        line,
    )


def rewrite_assets(
    line: str,
    prefix: str,
) -> str:
    """
    Rewrite paths into docs/images/ for the generated file's location.

    Original DOCUMENTATION.md:

        ![UI](images/ui.png)

    Generated content/*.md:

        ![UI](../../images/ui.png)

    Generated index.md:

        ![UI](../images/ui.png)

    Normal Markdown links into images/ are handled as well.
    """

    def markdown_replace(
        match: re.Match[str],
    ) -> str:
        opening = match.group(1)
        angle = match.group(2) or ""

        return (
            opening
            + angle
            + prefix
        )

    line = ASSET_LINK_RE.sub(
        markdown_replace,
        line,
    )

    line = HTML_IMAGE_RE.sub(
        lambda match: (
            match.group(1)
            + prefix
        ),
        line,
    )

    return line


def rewrite_outside_fences(
    text: str,
    targets: dict[str, str],
    image_prefix: str,
) -> str:
    """
    Rewrite Markdown links/assets across complete prose blocks rather than
    one line at a time.

    This allows wrapped Markdown links such as:

        [§2/Gain-offset estimation
        (PCFO)](#gainoffset-estimation-pcfo)

    to be resolved correctly.

    Fenced code blocks are left untouched.
    """

    output: list[str] = []
    prose_buffer: list[str] = []

    fence_char: str | None = None
    fence_len = 0

    def flush_prose() -> None:
        if not prose_buffer:
            return

        chunk = "".join(prose_buffer)

        chunk = rewrite_internal_links(
            chunk,
            targets,
        )

        chunk = rewrite_assets(
            chunk,
            image_prefix,
        )

        output.append(chunk)
        prose_buffer.clear()

    for line in text.splitlines(keepends=True):
        fence = fence_marker(line)

        # Outside a fence.
        if fence_char is None:
            if fence:
                flush_prose()

                output.append(line)

                fence_char, fence_len = fence
            else:
                prose_buffer.append(line)

            continue

        # Inside a fence: never rewrite it.
        output.append(line)

        if fence:
            char, length = fence

            if (
                char == fence_char
                and length >= fence_len
            ):
                fence_char = None
                fence_len = 0

    flush_prose()

    return "".join(output)

# Render generated Markdown
def render_page(
    page: Page,
    targets: dict[str, str],
    image_prefix: str,
    promote_headings: bool,
) -> str:
    """
    Render one generated Markdown document.

    For standalone content pages, heading levels are promoted by one:

        ## Page title     -> # Page title
        ### Section       -> ## Section
        #### Subsection   -> ### Subsection

    This gives every generated page a proper H1 title.
    """

    headings_by_line = {
        heading.line_index: heading
        for heading in page.headings
    }

    output: list[str] = [
        "<!--\n",
        "AUTO-GENERATED FROM docs/DOCUMENTATION.md\n",
        "DO NOT EDIT THIS FILE DIRECTLY.\n",
        "-->\n\n",
    ]

    fence_char: str | None = None
    fence_len = 0

    for line_index, original_line in enumerate(page.lines):
        line = original_line

        fence = fence_marker(line)

        # Headings outside code fences get explicit MyST targets.
        if (
            fence_char is None
            and line_index in headings_by_line
        ):
            heading = headings_by_line[line_index]

            output.append(
                f"({heading.label})=\n"
            )

            match = HEADING_RE.match(line)

            if match:
                level = len(match.group(1))

                if promote_headings and level >= 2:
                    level -= 1

                hashes = "#" * level

                # Use the cleaned heading title so an original {#id}
                # isn't duplicated in generated output.
                line = (
                    f"{hashes} "
                    f"{heading.title}\n"
                )

        output.append(line)

        # Update fenced-code state.
        if fence:
            char, length = fence

            if fence_char is None:
                fence_char = char
                fence_len = length

            elif (
                char == fence_char
                and length >= fence_len
            ):
                fence_char = None
                fence_len = 0

    rendered = "".join(output)

    rendered = rewrite_outside_fences(
        rendered,
        targets,
        image_prefix,
    )

    return rendered.rstrip() + "\n"

# Generate index.md

def build_index(
    preamble: Page,
    sections: list[Page],
    targets: dict[str, str],
) -> str:
    """
    Generate docs/readthedocs/index.md.

    The introduction/preamble from DOCUMENTATION.md becomes the landing page,
    followed by a MyST toctree containing all generated section pages.
    """

    if preamble.lines:
        body = render_page(
            preamble,
            targets,
            "../images/",
            promote_headings=False,
        )
    else:
        body = (
            "<!--\n"
            "AUTO-GENERATED FROM docs/DOCUMENTATION.md\n"
            "DO NOT EDIT THIS FILE DIRECTLY.\n"
            "-->\n\n"
            "# webSMLM Documentation\n"
        )

    entries = "\n".join(
        f"content/{Path(page.filename).stem}"
        for page in sections
        if page.filename
    )

    toctree = (
        "\n\n"
        "```{toctree}\n"
        ":maxdepth: 3\n"
        ":caption: Documentation\n"
        "\n"
        f"{entries}\n"
        "```\n"
    )

    return (
        body.rstrip()
        + toctree
    )


# Main build

def main() -> None:
    """
    Split docs/DOCUMENTATION.md into native MyST Markdown pages.

    """

    if not SOURCE_MD.exists():
        raise FileNotFoundError(
            f"Missing documentation source: {SOURCE_MD}"
        )

    source_lines = SOURCE_MD.read_text(
        encoding="utf-8",
    ).splitlines(
        keepends=True,
    )

    preamble, sections = split_pages(
        source_lines
    )

    if not sections:
        raise ValueError(
            "DOCUMENTATION.md contains no level-2 headings. "
            "Each Read the Docs page must start with a '## ...' heading."
        )

    # Remove separators that originally sat between major sections.
    preamble.lines = remove_trailing_separator(
        preamble.lines
    )

    for page in sections:
        page.lines = remove_trailing_separator(
            page.lines
        )

    # Scan the complete source before generating anything so cross-page
    # references can resolve in either direction.
    pages = [
        preamble,
        *sections,
    ]

    targets = scan_headings(
        pages
    )

    # Generated content is disposable. Rebuild it entirely every time so
    # deleted/renamed sections cannot leave stale pages behind.
    if CONTENT_DIR.exists():
        shutil.rmtree(
            CONTENT_DIR
        )

    CONTENT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    # Generate one Markdown page per ## section.
    for page in sections:
        if not page.filename:
            raise RuntimeError(
                f"Could not determine filename for section: {page.title}"
            )

        rendered = render_page(
            page,
            targets,
            "../../images/",
            promote_headings=True,
        )

        destination = (
            CONTENT_DIR
            / page.filename
        )

        destination.write_text(
            rendered,
            encoding="utf-8",
        )

        print(
            "generated "
            f"{destination.relative_to(DOCS_DIR.parent)}"
        )

    # Generate the RTD landing page/toctree.
    INDEX_MD.write_text(
        build_index(
            preamble,
            sections,
            targets,
        ),
        encoding="utf-8",
    )

    print(
        "generated "
        f"{INDEX_MD.relative_to(DOCS_DIR.parent)}"
    )

    print(
        f"pages: {len(sections)}"
    )


if __name__ == "__main__":
    main()