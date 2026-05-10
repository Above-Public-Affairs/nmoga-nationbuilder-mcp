from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT

OUTPUT = "/Users/jc/Library/Mobile Documents/com~apple~CloudDocs/Development/NMOGA NationBuilder API/NationBuilder MCP Capabilities.pdf"

doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=letter,
    leftMargin=0.55*inch,
    rightMargin=0.55*inch,
    topMargin=0.5*inch,
    bottomMargin=0.45*inch,
)

# NMOGA Brand Colors
NAVY       = colors.HexColor("#012A3F")
GREEN      = colors.HexColor("#00B550")
GREEN_DARK = colors.HexColor("#009040")
NAVY_LIGHT = colors.HexColor("#0a3d57")
CARD_BG    = colors.HexColor("#f2f8fb")
CARD_BG2   = colors.HexColor("#eaf6ee")
WHITE      = colors.white
MID_GRAY   = colors.HexColor("#888888")
DARK_GRAY  = colors.HexColor("#333333")

styles = getSampleStyleSheet()

title_style = ParagraphStyle("T", fontSize=20, textColor=WHITE,
    fontName="Helvetica-Bold", alignment=TA_CENTER, spaceAfter=2, leading=24)
subtitle_style = ParagraphStyle("S", fontSize=9.5, textColor=colors.HexColor("#aad4e0"),
    fontName="Helvetica", alignment=TA_CENTER, spaceAfter=0, leading=13)
icon_style = ParagraphStyle("I", fontSize=22, alignment=TA_CENTER,
    fontName="Helvetica", spaceAfter=4, leading=26)
card_title_style = ParagraphStyle("CT", fontSize=9, textColor=NAVY,
    fontName="Helvetica-Bold", alignment=TA_CENTER, spaceAfter=3, leading=11)
card_body_style = ParagraphStyle("CB", fontSize=7.5, textColor=DARK_GRAY,
    fontName="Helvetica", alignment=TA_CENTER, leading=10.5, spaceAfter=0)
footer_style = ParagraphStyle("F", fontSize=8, textColor=MID_GRAY,
    fontName="Helvetica", alignment=TA_CENTER, leading=11)
footer_bold = ParagraphStyle("FB", fontSize=8, textColor=NAVY,
    fontName="Helvetica-Bold", alignment=TA_CENTER)

# 13 capability cards — icon, title, short description
capabilities = [
    ("🔍", "Search & Filter People",
     "Find anyone by name, email, location, support level, tag, or custom field. Combine multiple filters at once."),
    ("👤", "View & Update Contacts",
     "Pull up a full profile, update phone, email, employer, support level, and more. Create new contacts on the spot."),
    ("🏷️", "Tags",
     "Add or remove tags from any contact. Search everyone with a given tag. New tags are created automatically."),
    ("📋", "Lists & Segments",
     "Browse saved lists, see who's in them, and create new ones instantly for mailings, events, or outreach."),
    ("🤝", "Memberships",
     "View membership records, check types and dues, and create new membership records when someone joins or renews."),
    ("📅", "Events",
     "List upcoming and past events or pull up details — date, location, capacity — on any specific event."),
    ("📜", "Petitions",
     "See all active petitions and check current signature counts on any individual petition."),
    ("✉️", "Mailings & Broadcasts",
     "Browse sent and scheduled mailings — subject lines, send dates, and recipient counts at a glance."),
    ("🌐", "Website Pages & Sites",
     "List all your NationBuilder pages — basic, event, donation, and more — and view details on any page."),
    ("🤖", "Automations",
     "See what automated workflows are running and check who is currently enrolled in each one."),
    ("🔗", "Org Relationships",
     "Find every contact linked to a specific employer or organization — great for corporate or coalition research."),
    ("🛤️", "Paths & Journeys",
     "View engagement paths and see exactly where each person is in their journey — and whether they've completed it."),
    ("📥", "Imports & Data",
     "Check import status: how many records were created, updated, or flagged with errors."),
]

story = []

# ── Header bar ────────────────────────────────────────────────────────────────
header_data = [[
    Paragraph("NationBuilder Assistant", title_style),
    Paragraph("Ask Claude anything about your NationBuilder database — no technical knowledge needed.", subtitle_style),
]]
header_table = Table(header_data, colWidths=[2.5*inch, 7.3*inch])
header_table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, -1), NAVY),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 14),
    ("RIGHTPADDING", (0, 0), (-1, -1), 14),
    ("TOPPADDING", (0, 0), (-1, -1), 14),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
]))
story.append(header_table)
story.append(Spacer(1, 10))

# ── Green accent bar ──────────────────────────────────────────────────────────
story.append(HRFlowable(width="100%", thickness=3, color=GREEN, spaceAfter=10))

# ── Capability cards in a 4-column grid ──────────────────────────────────────
PAGE_W = letter[0] - 1.1*inch
COLS = 4
GAP = 6
col_w = (PAGE_W - GAP * (COLS - 1)) / COLS

rows = []
row = []
for i, (icon, title, desc) in enumerate(capabilities):
    cell_content = [
        Paragraph(icon, icon_style),
        Paragraph(title, card_title_style),
        Paragraph(desc, card_body_style),
    ]
    row.append(cell_content)
    if len(row) == COLS:
        rows.append(row)
        row = []

# Pad last row
if row:
    while len(row) < COLS:
        row.append("")
    rows.append(row)

grid = Table(rows, colWidths=[col_w] * COLS, rowHeights=None)

# Alternate card background by row for subtle rhythm
style_cmds = [
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("ALIGN",  (0, 0), (-1, -1), "CENTER"),
    ("LEFTPADDING",   (0, 0), (-1, -1), 8),
    ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
    ("TOPPADDING",    (0, 0), (-1, -1), 10),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ("GRID", (0, 0), (-1, -1), 2, WHITE),
    ("ROWBACKGROUNDS", (0, 0), (-1, -1), [CARD_BG, CARD_BG2]),
    # Green top border on each card column
    ("LINEABOVE", (0, 0), (-1, 0), 3, GREEN),
    ("LINEABOVE", (0, 1), (-1, 1), 3, GREEN),
    ("LINEABOVE", (0, 2), (-1, 2), 3, GREEN),
    ("LINEABOVE", (0, 3), (-1, 3), 3, GREEN),
]
grid.setStyle(TableStyle(style_cmds))

story.append(grid)
story.append(Spacer(1, 10))

# ── Footer ────────────────────────────────────────────────────────────────────
story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#cccccc"), spaceAfter=6))

footer_data = [[
    Paragraph("💬  Just ask naturally:", footer_bold),
    Paragraph(
        '"Who are our members in Lea County?" &nbsp;&nbsp;·&nbsp;&nbsp; '
        '"Show me everyone tagged Legislator" &nbsp;&nbsp;·&nbsp;&nbsp; '
        '"Create a list called 2026 Donors"',
        footer_style
    ),
]]
footer_table = Table(footer_data, colWidths=[1.6*inch, PAGE_W - 1.6*inch])
footer_table.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ("TOPPADDING", (0, 0), (-1, -1), 0),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
]))
story.append(footer_table)

doc.build(story)
print(f"Saved: {OUTPUT}")
