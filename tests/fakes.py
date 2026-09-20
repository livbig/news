"""Общая тест-инфраструктура: один Dispatcher на процесс (роутеры aiogram
нельзя подключать повторно) + fake-бот и конструкторы обновлений."""
import functools
import uuid
from datetime import datetime, timezone

from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import CallbackQuery, Chat, Message, User


@functools.lru_cache(maxsize=1)
def shared_dispatcher() -> Dispatcher:
    from bot.handlers import build_dispatcher

    return build_dispatcher()  # М4: единый синглтон на процесс (роутеры одни)


class _SentMessage:
    """Возврат bot.send_message: достаточно для хендлеров, вызывающих
    .edit_text/.delete у отправленного сообщения (11d: placeholder подбора)."""

    def __init__(self, bot, chat_id, message_id):
        self._bot = bot
        self.chat = Chat(id=chat_id, type="private")
        self.message_id = message_id

    async def edit_text(self, text, reply_markup=None):
        from aiogram.methods import EditMessageText

        await self._bot(EditMessageText(
            chat_id=self.chat.id, message_id=self.message_id,
            text=text, reply_markup=reply_markup,
        ))
        return True

    async def delete(self):
        from aiogram.methods import DeleteMessage

        await self._bot(DeleteMessage(
            chat_id=self.chat.id, message_id=self.message_id))
        return True


class FakeBot(Bot):
    """Перехват Telegram-методов на уровне bot.__call__ — сеть не трогаем."""

    def __init__(self):
        super().__init__(token="1:TEST")
        self.calls = []

    async def __call__(self, method, request_timeout=None):
        self.calls.append((type(method).__name__, method.model_dump(exclude_none=True)))
        if type(method).__name__ == "SendMessage":
            return _SentMessage(self, method.chat_id, 1000 + len(self.calls))
        return True

    def sent_texts(self):
        return [v["text"] for t, v in self.calls if t == "SendMessage"]

    def edited_texts(self):
        return [v["text"] for t, v in self.calls if t == "EditMessageText"]


def make_message(chat_id, user_id, text, message_id=10):
    return Message(
        message_id=message_id,
        date=datetime.now(timezone.utc),
        chat=Chat(id=chat_id, type="private"),
        from_user=User(id=user_id, is_bot=False, first_name="T"),
        text=text,
    )


def make_callback(chat_id, user_id, data, message_id=10):
    return CallbackQuery(
        id=uuid.uuid4().hex[:8],
        from_user=User(id=user_id, is_bot=False, first_name="T"),
        chat_instance="ci",
        data=data,
        message=make_message(chat_id, user_id, "", message_id),
    )
