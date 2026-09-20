from aiogram.fsm.state import State, StatesGroup


class Survey(StatesGroup):
    """Онбординг и повторный опрос (11d/D45): LLM-интервью → подбор
    источников → расписание."""

    rs_mode = State()    # повторный опрос: заменить / добавить поверх (D22)
    interview = State()  # раунды интервью (кнопки «Достаточно»/«Пропустить»)
    profile = State()    # черновик профиля: «Подправить» / «Верно»
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
