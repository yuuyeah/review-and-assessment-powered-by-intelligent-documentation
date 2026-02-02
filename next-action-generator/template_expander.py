"""
Template Variable Expansion for Next Action Generation

This module expands template variables in prompt templates with actual data.

TEMPLATE VARIABLES:
- {{all_results}} - All review results with full details (checkList, result, explanation,
                    sourceReferences with filename and page number, etc.)
"""
import json
from typing import Any, Dict, List


def expand_template_variables(template: str, data: Dict[str, Any]) -> str:
    """
    Expand template variables in the prompt template.

    Args:
        template: The prompt template with {{variable}} placeholders
        data: Dictionary containing the data to expand

    Returns:
        The expanded prompt with variables replaced by actual values
    """
    result = template

    # {{all_results}}
    result = result.replace(
        "{{all_results}}", format_all_results(data.get("allResults", []))
    )

    return result


def format_all_results(items: List[Dict[str, Any]]) -> str:
    """Format all review results with full details for the prompt."""
    if not items:
        return "No results available."

    formatted = []
    for item in items:
        result = item.get("result", "pending")
        result_text = "Pass" if result == "pass" else "Fail" if result == "fail" else "Pending"
        override = " (User Override)" if item.get("userOverride") else ""

        # Build header with parent category if available
        check_list = item.get("checkList", {})
        name = check_list.get("name", "Unknown")
        parent_name = check_list.get("parentName")
        if parent_name:
            header = f"### [{parent_name}] {name}: {result_text}{override}"
        else:
            header = f"### {name}: {result_text}{override}"

        parts = [header]

        # Description
        description = check_list.get("description")
        if description:
            parts.append(f"- Rule: {description}")

        # Confidence
        confidence = item.get("confidenceScore")
        if confidence is not None:
            parts.append(f"- Confidence: {int(confidence * 100)}%")

        # Explanation
        explanation = item.get("explanation")
        if explanation:
            parts.append(f"- Explanation: {explanation}")

        # Extracted text
        extracted_text = item.get("extractedText")
        if extracted_text:
            parsed = _parse_extracted_text(extracted_text)
            if parsed:
                parts.append(f'- Extracted text: "{"\", \"".join(parsed[:3])}"')

        # Source references (filename + page)
        refs = item.get("sourceReferences", [])
        if refs:
            ref_strs = []
            for ref in refs[:5]:  # Limit to 5 references
                filename = ref.get("filename", "Unknown")
                page = ref.get("pageNumber")
                if page:
                    ref_strs.append(f"{filename} (p.{page})")
                else:
                    ref_strs.append(filename)
            parts.append(f"- Sources: {', '.join(ref_strs)}")

        # User comment (for overrides)
        user_comment = item.get("userComment")
        if user_comment:
            parts.append(f"- User comment: {user_comment}")

        formatted.append("\n".join(parts))

    return "\n\n".join(formatted)


def _parse_extracted_text(value: str) -> List[str]:
    """Parse extracted text which may be JSON array or plain text."""
    if not value:
        return []

    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return parsed
    except (json.JSONDecodeError, TypeError):
        # Not JSON, treat as plain text
        if value.strip():
            return [value.strip()]

    return []
