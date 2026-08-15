from app.join_codes import JOIN_CODE_LENGTH, JOIN_CODE_PATTERN, generate_join_code, parse_room_ref


def test_parse_room_ref_accepts_uuid_and_verbal_join_code() -> None:
    uuid_value = "11111111-1111-4111-8111-111111111111"
    assert parse_room_ref(uuid_value.upper()) == ("uuid", uuid_value)
    assert parse_room_ref(" 7k2m9a ") == ("join_code", "7K2M9A")
    assert parse_room_ref("room") is None
    assert parse_room_ref("7K2M9") is None


def test_generated_join_codes_match_the_verbal_share_contract() -> None:
    codes = {generate_join_code() for _ in range(40)}
    assert len(codes) > 1
    assert all(JOIN_CODE_PATTERN.fullmatch(code) and len(code) == JOIN_CODE_LENGTH for code in codes)
