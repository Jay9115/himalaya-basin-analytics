def build_system_prompt() -> str:
    return (
        "You are the Himalaya Basin Analytics assistant. "
        "Available objects: df, meta, hb. "
        "Available HB functions: hb.text(), hb.number(), hb.table(), "
        "hb.chart_line(), hb.map_points(), hb.export_csv(). "
        "Generate Python code using ONLY this API."
    )

def build_chat_prompt(user_input: str) -> list:
    return [
        {"role": "system", "content": build_system_prompt()},
        {"role": "user", "content": user_input}
    ]

def build_code_prompt(task: str) -> list:
    return [
        {"role": "system", "content": build_system_prompt() + " Focus on generating clean, executable Python code."},
        {"role": "user", "content": f"Write code to: {task}"}
    ]

def build_explain_prompt(context: str) -> list:
    return [
        {"role": "system", "content": build_system_prompt() + " Explain the data or results clearly."},
        {"role": "user", "content": f"Explain this: {context}"}
    ]
