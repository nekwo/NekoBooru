import asyncio
import hashlib
import unittest

import auto_tag_support as support


class ContentMd5Tests(support.AutoTagApiTestCase):
    """Posts carry their file's MD5, the id boorus publish, and older posts get it backfilled."""

    def _stored_file_md5(self, post):
        from app.config import settings
        from app.models import Post

        async def read():
            from app.database import async_session

            async with async_session() as session:
                row = await session.get(Post, post["id"])
                return row.md5, hashlib.md5((settings.posts_dir / row.content_path).read_bytes()).hexdigest()

        return asyncio.run(read())

    def _set_md5(self, post_id, value):
        from app.models import Post

        async def write():
            from app.database import async_session

            async with async_session() as session:
                row = await session.get(Post, post_id)
                row.md5 = value
                await session.commit()

        asyncio.run(write())

    def test_upload_stores_the_file_md5(self):
        post = self._upload_image_post()
        stored, actual = self._stored_file_md5(post)
        self.assertEqual(stored, actual)

    def test_backfill_fills_posts_without_one_and_marks_missing_files(self):
        from app.config import settings
        from app.models import Post
        from app.services.content_md5 import backfill_md5s

        present = self._upload_image_post()
        gone = self._upload_image_post()
        for post in (present, gone):
            self._set_md5(post["id"], None)

        async def remove_file_and_backfill():
            from app.database import async_session

            async with async_session() as session:
                row = await session.get(Post, gone["id"])
                (settings.posts_dir / row.content_path).unlink()
            filled = await backfill_md5s()
            async with async_session() as session:
                return filled, (await session.get(Post, gone["id"])).md5

        filled, gone_md5 = asyncio.run(remove_file_and_backfill())
        self.assertGreaterEqual(filled, 1)
        self.assertEqual(gone_md5, "")  # unreadable: never re-selected
        stored, actual = self._stored_file_md5(present)
        self.assertEqual(stored, actual)


if __name__ == "__main__":
    unittest.main()
