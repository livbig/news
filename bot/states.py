from aiogram.fsm.state import State, StatesGroup


class Survey(StatesGroup):
    """Онбординг и повторный опрос (план §1.3)."""

    rs_mode = State()  # повторный опрос: заменить / добавить поверх (D22)
    topics = State()
    sources = State()
    freq = State()
    time = State()
    confirm = State()


class AddSource(StatesGroup):
    """Мастер добавления источника (план §1.3): тип → адрес → превью."""

    kind = State()
    url = State()
    preview = State()


class Settings(StatesGroup):
    """Настройки расписания (план §1.3): мультивыбор времён, частота = их число."""

    time = State()
