def format_number(value, decimals=2):
    try:
        return round(float(value), decimals)
    except Exception:
        return value


def format_size(value):
    return format_number(value, 6)


